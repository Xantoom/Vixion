//! Vixion: records Twitch channels and plays the recordings back in the browser.

mod alerts;
mod api;
mod app;
mod auth;
mod config;
mod crypto;
mod db;
mod error;
mod logs;
mod media;
mod media_server;
mod recorder;
mod settings;
mod system;
mod tls;
mod twitch;
mod web;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::middleware;

use crate::app::{App, AppState};
use crate::config::{Config, MediaMode};
use crate::recorder::{Recorder, retention};

const USAGE: &str = "Usage:
  vixion                              run the server
  vixion healthcheck                  exit 0 when the local server answers (for Docker)
  vixion reset-password <user> <new>  set an account's password and sign it out everywhere
  vixion version

Configuration is read from VIXION_* environment variables; see the README.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("configuration error: {error}");
            return ExitCode::from(2);
        }
    };
    match args.first().map(String::as_str) {
        None | Some("serve") => {}
        Some("healthcheck") => return healthcheck(&config),
        Some("version" | "--version" | "-V") => {
            println!("vixion {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Some("reset-password") if args.len() == 3 => return reset_password(&config, &args[1], &args[2]),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    }

    // Recording is I/O bound: a few workers are enough and keep memory low.
    let workers = std::thread::available_parallelism().map_or(2, |n| n.get().clamp(2, 4));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .max_blocking_threads(16)
        .thread_name("vixion")
        .enable_all()
        .build();
    match runtime {
        Ok(runtime) => runtime.block_on(serve(config)),
        Err(error) => {
            eprintln!("can't start: {error}");
            ExitCode::FAILURE
        }
    }
}

fn healthcheck(config: &Config) -> ExitCode {
    use std::io::{Read, Write};
    let port = config.http_addr.port();
    let attempt = || -> std::io::Result<bool> {
        let mut stream =
            std::net::TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(3))?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.write_all(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut answer = String::new();
        stream.read_to_string(&mut answer)?;
        Ok(answer.starts_with("HTTP/1.1 200"))
    };
    if attempt().unwrap_or(false) { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

fn reset_password(config: &Config, username: &str, password: &str) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let result = runtime.block_on(async {
        auth::validate_password(password)?;
        let db = db::Db::open(&config.db_path())?;
        let hash = auth::hash_password(password.to_owned()).await?;
        let username = username.to_owned();
        db.write(move |conn| {
            let changed = conn
                .execute("UPDATE users SET password_hash = ?2, disabled = 0 WHERE username = ?1", [&username, &hash])?;
            if changed == 0 {
                return Err(error::AppError::not_found());
            }
            conn.execute(
                "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?1)",
                [&username],
            )?;
            Ok(())
        })
        .await
    });
    match result {
        Ok(()) => {
            println!("password changed");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: Config) -> ExitCode {
    let logs = logs::init(&config.log_filter, config.log_json);
    match start(config, logs).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!("{error}");
            ExitCode::FAILURE
        }
    }
}

async fn start(config: Config, logs: logs::LogBuffer) -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    std::fs::create_dir_all(config.streams_dir())?;
    let db = db::Db::open(&config.db_path())?;
    let keys = crypto::Keys::load_or_create(&config.data_dir.join("secret.key"))?;
    auth::seed_roles(&db).await?;
    let settings = settings::SettingsStore::load(db.clone(), keys.clone()).await?;
    api_retention(&settings).await;
    let http = reqwest::Client::builder()
        .user_agent(twitch::api::USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()?;
    let alerts = alerts::Alerts::new(db.clone(), settings.clone(), http.clone());
    let app: AppState = Arc::new(App {
        twitch: twitch::api::TwitchApi::new(http.clone()),
        chat_assets: twitch::emotes::ChatAssetCache::default(),
        http,
        alerts,
        settings,
        keys,
        db,
        logs,
        recorder: Recorder::new(),
        limiter: auth::LoginLimiter::new(),
        started_at: db::now_ms(),
        config,
    });
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        data = %app.config.data_dir.display(),
        "starting"
    );
    if let Err(error) = retention::recover(&app).await {
        tracing::error!(%error, "recovering interrupted recordings failed");
    }

    tokio::spawn(recorder::run(app.clone()));
    tokio::spawn(retention::run(app.clone()));

    let mut main_router = Router::new().nest("/api", api::router());
    if app.config.media_mode == MediaMode::Same {
        main_router = main_router.merge(media_server::router());
    }
    let main_router = main_router
        .fallback(web::serve)
        .layer(middleware::from_fn_with_state(app.clone(), web::security_headers))
        .with_state(app.clone());
    let listener = tokio::net::TcpListener::bind(app.config.http_addr).await?;
    tracing::info!(address = %app.config.http_addr, "interface listening");

    let (shutdown, _) = tokio::sync::broadcast::channel::<()>(1);
    let mut servers = Vec::new();
    {
        let mut stop = shutdown.subscribe();
        servers.push(tokio::spawn(async move {
            axum::serve(listener, main_router.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move {
                    let _ = stop.recv().await;
                })
                .await
        }));
    }

    let media_router = media_server::router().with_state(app.clone());
    match app.config.media_mode {
        MediaMode::Same => {}
        MediaMode::Http => {
            let listener = tokio::net::TcpListener::bind(app.config.media_addr).await?;
            tracing::info!(address = %app.config.media_addr, public = %app.config.media_public_url, "media listening (HTTP)");
            let mut stop = shutdown.subscribe();
            servers.push(tokio::spawn(async move {
                axum::serve(listener, media_router)
                    .with_graceful_shutdown(async move {
                        let _ = stop.recv().await;
                    })
                    .await
            }));
        }
        MediaMode::Https => {
            let slot = Arc::new(tls::CertSlot::default());
            tokio::spawn(tls::maintain(app.clone(), Arc::clone(&slot)));
            if app.config.ddns {
                tokio::spawn(tls::dynamic_dns(app.clone()));
            }
            let listener = tls::listen(app.config.media_addr, slot).await?;
            tracing::info!(address = %app.config.media_addr, public = %app.config.media_public_url, "media listening (HTTPS)");
            let mut stop = shutdown.subscribe();
            servers.push(tokio::spawn(async move {
                axum::serve(listener, media_router)
                    .with_graceful_shutdown(async move {
                        let _ = stop.recv().await;
                    })
                    .await
            }));
        }
    }

    wait_for_signal().await;
    tracing::info!("stopping: closing recordings");
    app.recorder.stop_all();
    let deadline = Instant::now() + Duration::from_secs(25);
    while !app.recorder.live().is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = shutdown.send(());
    for server in servers {
        let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    }
    tracing::info!("stopped");
    Ok(())
}

async fn api_retention(settings: &settings::SettingsStore) {
    api::set_global_retention(settings.get().await.retention_days);
}

async fn wait_for_signal() {
    let interrupt = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut terminate = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(_) => {
                let _ = interrupt.await;
                return;
            }
        };
        tokio::select! {
            _ = interrupt => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = interrupt.await;
}
