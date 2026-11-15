//! Vixion: records Twitch channels and plays the recordings back in the browser.

mod alerts;
mod api;
mod app;
mod audit;
mod auth;
mod body;
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
mod upnp;
mod web;

// musl's allocator is slow under many threads: video was served at half the speed of a glibc build.
#[cfg(target_env = "musl")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::middleware;

use crate::app::{App, AppState};
use crate::config::Config;
use crate::recorder::{Recorder, retention};

const USAGE: &str = "Usage:
  vixion [options]                    run the server
  vixion healthcheck [--port <port>]  exit 0 when the local server answers (for Docker)
  vixion reset-password <user>        set an account's password (asked for) and sign it out everywhere
  vixion version

Options:
  --twitch-token <token>   the Twitch account's auth-token cookie (or VIXION_TWITCH_TOKEN): required
  --port <port>            the interface, 6280 by default; or an address, such as 127.0.0.1:6280
  --video-port <port>      the video, 6281 by default

Reaching the video from the internet is set with VIXION_* variables; see the README.";

/// Takes `--name <value>` or `--name=value` out of the arguments.
fn take_option(args: &mut Vec<String>, name: &str) -> Result<Option<String>, String> {
    let prefix = format!("{name}=");
    let Some(at) = args.iter().position(|arg| arg == name || arg.starts_with(&prefix)) else {
        return Ok(None);
    };
    let arg = args.remove(at);
    match arg.strip_prefix(&prefix) {
        Some(value) => Ok(Some(value.to_owned())),
        None if at < args.len() => Ok(Some(args.remove(at))),
        None => Err(format!("{name} needs a value")),
    }
}

/// Applies the options to the configuration read from the environment.
fn apply_options(args: &mut Vec<String>, config: &mut Config) -> Result<(), String> {
    if let Some(token) = take_option(args, "--twitch-token")? {
        config.twitch_token = Some(config::parse_twitch_token(&token).map_err(|e| format!("--twitch-token: {e}"))?);
    }
    if let Some(port) = take_option(args, "--port")? {
        config.http_addr = config::parse_addr(&port).map_err(|e| format!("--port: {e}"))?;
    }
    if let Some(port) = take_option(args, "--video-port")? {
        config.media_addr = config::parse_addr(&port).map_err(|e| format!("--video-port: {e}"))?;
    }
    if config.http_addr.port() == config.media_addr.port() {
        return Err("the interface and the video need two different ports".into());
    }
    Ok(())
}

/// mimalloc's defaults trade memory for speed it doesn't bring here: without eager commits and with
/// memory returned at once, the server rests at a few megabytes instead of twenty, just as fast.
/// `MIMALLOC_*` variables still win.
#[cfg(target_env = "musl")]
fn tune_allocator() {
    // Indexes in mimalloc's `mi_option_t`.
    const ARENA_EAGER_COMMIT: libmimalloc_sys::mi_option_t = 4;
    const PURGE_DELAY: libmimalloc_sys::mi_option_t = 15;
    for (option, variable) in
        [(ARENA_EAGER_COMMIT, "MIMALLOC_ARENA_EAGER_COMMIT"), (PURGE_DELAY, "MIMALLOC_PURGE_DELAY")]
    {
        if std::env::var_os(variable).is_none() {
            // SAFETY: sets a plain integer option; mimalloc allows it at any time.
            unsafe { libmimalloc_sys::mi_option_set(option, 0) };
        }
    }
}

fn main() -> ExitCode {
    #[cfg(target_env = "musl")]
    tune_allocator();
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("configuration error: {error}");
            return ExitCode::from(2);
        }
    };
    // Options win over the environment.
    if let Err(error) = apply_options(&mut args, &mut config) {
        eprintln!("configuration error: {error}");
        return ExitCode::from(2);
    }
    match args.first().map(String::as_str) {
        None | Some("serve") => {}
        Some("healthcheck") => return healthcheck(&config),
        Some("version" | "--version" | "-V") => {
            println!("vixion {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        // Read from the terminal, not the command line, which other users and the shell history see.
        Some("reset-password") if args.len() == 2 => {
            eprint!("New password for {}: ", args[1]);
            let Ok(password) = read_password() else { return ExitCode::FAILURE };
            return reset_password(&config, &args[1], &password);
        }
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

/// Reads a line from the terminal without showing it: someone behind the screen shouldn't see it.
fn read_password() -> std::io::Result<String> {
    let mut password = String::new();
    {
        let _hidden = HiddenInput::start();
        std::io::stdin().read_line(&mut password)?;
    }
    // The newline typed wasn't shown either.
    eprintln!();
    Ok(password.trim_end_matches(['\r', '\n']).to_owned())
}

/// Turns the terminal's echo off while it lives. Does nothing when the input isn't a terminal
/// (a password piped in).
struct HiddenInput {
    #[cfg(unix)]
    saved: Option<libc::termios>,
}

impl HiddenInput {
    #[cfg(unix)]
    fn start() -> Self {
        let mut saved = std::mem::MaybeUninit::<libc::termios>::zeroed();
        // SAFETY: `saved` is writable memory of the right type, which tcgetattr fills when it
        // returns 0; standard input stays open for the whole process.
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, saved.as_mut_ptr()) } != 0 {
            return Self { saved: None };
        }
        // SAFETY: tcgetattr returned 0, so it filled the structure.
        let saved = unsafe { saved.assume_init() };
        let mut hidden = saved;
        hidden.c_lflag &= !libc::ECHO;
        // SAFETY: `hidden` is a valid termios, copied from the terminal's own.
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &raw const hidden) };
        Self { saved: Some(saved) }
    }

    #[cfg(not(unix))]
    fn start() -> Self {
        Self {}
    }
}

impl Drop for HiddenInput {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(saved) = &self.saved {
            // SAFETY: `saved` is the terminal's settings as tcgetattr gave them.
            unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, saved) };
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
    let settings = settings::SettingsStore::load(db.clone(), keys.clone(), config.twitch_token.clone()).await?;
    match settings.get().await.twitch_token_source {
        Some(settings::TokenSource::Config) => {}
        // Saved from the interface by an earlier version: still used, so an update doesn't stop recording.
        Some(settings::TokenSource::Stored) => {
            tracing::warn!(
                "the Twitch token was saved by an earlier version: set VIXION_TWITCH_TOKEN, it will be required"
            );
        }
        None => {
            return Err("Vixion needs a Twitch token: set VIXION_TWITCH_TOKEN (or --twitch-token) to the auth-token \
                        cookie of twitch.tv; see the README"
                .into());
        }
    }
    let http = reqwest::Client::builder()
        .user_agent(twitch::api::USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()?;
    // Webhooks don't follow redirects: the address set is the only one reached.
    let webhooks = reqwest::Client::builder()
        .user_agent(concat!("Vixion/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let alerts = alerts::Alerts::new(db.clone(), settings.clone(), webhooks);
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
        setup_code: std::sync::Mutex::new(None),
        started_at: db::now_ms(),
        config,
    });
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        data = %app.config.data_dir.display(),
        recordings = %app.config.recordings_dir.display(),
        "starting"
    );
    auth::announce_setup(&app).await?;
    if let Err(error) = retention::recover(&app, None).await {
        tracing::error!(%error, "recovering interrupted recordings failed");
    }

    // Retention starts from there, once the recordings are in order.
    tokio::spawn(recorder::run(app.clone()));

    let main_router = Router::new()
        .nest("/api", api::router())
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
    let media = match &app.config.tls {
        None => {
            let listener = tokio::net::TcpListener::bind(app.config.media_addr).await?;
            tracing::info!(address = %app.config.media_addr, public = ?app.config.media_public_url, "video listening (HTTP)");
            let mut stop = shutdown.subscribe();
            tokio::spawn(async move {
                axum::serve(listener, media_router)
                    .with_graceful_shutdown(async move {
                        let _ = stop.recv().await;
                    })
                    .await
            })
        }
        Some(_) => {
            let slot = Arc::new(tls::CertSlot::default());
            tokio::spawn(tls::maintain(app.clone(), Arc::clone(&slot)));
            if app.config.ddns {
                tokio::spawn(tls::dynamic_dns(app.clone()));
            }
            let listener = tls::listen(app.config.media_addr, slot).await?;
            tracing::info!(address = %app.config.media_addr, domain = %app.config.media_domain, "video listening (HTTPS)");
            let mut stop = shutdown.subscribe();
            tokio::spawn(async move {
                axum::serve(listener, media_router)
                    .with_graceful_shutdown(async move {
                        let _ = stop.recv().await;
                    })
                    .await
            })
        }
    };
    servers.push(media);

    // The router forwards the media port here, and stops when the process does.
    let upnp = app.config.upnp.then(|| tokio::spawn(upnp::run(app.clone(), shutdown.subscribe())));

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
    if let Some(upnp) = upnp {
        let _ = tokio::time::timeout(Duration::from_secs(5), upnp).await;
    }
    tracing::info!("stopped");
    Ok(())
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
