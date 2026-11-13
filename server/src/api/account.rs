//! First start, signing in and out, and one's own account.

use std::net::SocketAddr;

use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app::AppState;
use crate::auth::{self, CurrentUser};
use crate::config::MediaMode;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};

#[derive(Deserialize)]
pub struct Credentials {
    username: String,
    password: String,
    #[serde(default)]
    locale: Option<String>,
    /// The setup code from the server's log, for the first account.
    #[serde(default)]
    code: Option<String>,
}

pub async fn setup_needed(State(app): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let users: i64 =
        app.db.read(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?)).await?;
    Ok(Json(json!({ "needed": users == 0 })))
}

/// Creates the first account, an administrator. Refused once any account exists.
pub async fn setup(
    State(app): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<Credentials>,
) -> AppResult<Response> {
    let ip_key = format!("setup:{}", auth::client_ip(&headers, Some(peer), app.config.trust_proxy));
    if !app.limiter.allow(&[ip_key]) {
        return Err(AppError::new(StatusCode::TOO_MANY_REQUESTS, "too_many_attempts", "try again in 15 minutes"));
    }
    let expected = app.setup_code.lock().ok().and_then(|code| code.clone());
    let given: String = body.code.as_deref().unwrap_or_default().chars().filter(char::is_ascii_alphanumeric).collect();
    let matches = expected.is_some_and(|code| {
        let code: String = code.chars().filter(char::is_ascii_alphanumeric).collect();
        crate::crypto::same(code.as_bytes(), given.to_ascii_uppercase().as_bytes())
    });
    if !matches {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "bad_setup_code",
            "the setup code is wrong: see the server's log",
        ));
    }
    let username = body.username.trim().to_owned();
    auth::validate_username(&username)?;
    auth::validate_password(&body.password)?;
    let hash = auth::hash_password(body.password).await?;
    let locale = body.locale.filter(|locale| matches!(locale.as_str(), "en" | "fr"));
    let user_id = app
        .db
        .write(move |conn| {
            let tx = conn.transaction()?;
            let users: i64 = tx.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
            if users > 0 {
                return Err(AppError::conflict("already_set_up", "an account already exists"));
            }
            let admin: i64 = tx.query_row("SELECT id FROM roles WHERE builtin = 'admin'", [], |row| row.get(0))?;
            tx.execute(
                "INSERT INTO users (username, password_hash, role_id, locale, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![username, hash, admin, locale, now_ms()],
            )?;
            let id = tx.last_insert_rowid();
            tx.commit()?;
            Ok(id)
        })
        .await?;
    if let Ok(mut code) = app.setup_code.lock() {
        *code = None;
    }
    tracing::info!(user_id, "administrator account created");
    signed_in(&app, user_id, &headers).await
}

async fn signed_in(app: &AppState, user_id: i64, headers: &HeaderMap) -> AppResult<Response> {
    let agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|v| v.chars().take(200).collect());
    let token = auth::create_session(&app.db, user_id, agent).await?;
    let user = app.db.read(move |conn| auth::load_user(conn, user_id)).await?.ok_or_else(AppError::unauthorized)?;
    Ok(([(header::SET_COOKIE, auth::session_cookie(&token, headers))], Json(user)).into_response())
}

pub async fn login(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Credentials>,
) -> AppResult<Response> {
    let username = body.username.trim().to_owned();
    let ip_key = format!("ip:{}", auth::client_ip(&headers, Some(peer), app.config.trust_proxy));
    let user_key = format!("user:{}", username.to_lowercase());
    if !app.limiter.allow(&[ip_key, user_key.clone()]) {
        tracing::warn!(%username, "sign-in blocked: too many attempts");
        return Err(AppError::new(StatusCode::TOO_MANY_REQUESTS, "too_many_attempts", "try again in 15 minutes"));
    }
    let lookup = username.clone();
    let found: Option<(i64, String, bool)> = app
        .db
        .read(move |conn| {
            Ok(conn
                .query_row("SELECT id, password_hash, disabled FROM users WHERE username = ?1", [lookup], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0))
                })
                .ok())
        })
        .await?;
    // Unknown names cost as much as wrong passwords, so names can't be probed by timing.
    let (user_id, valid, disabled) = match found {
        Some((user_id, hash, disabled)) => (user_id, auth::verify_password(body.password, hash).await, disabled),
        None => {
            let _ = auth::hash_password(body.password).await;
            (0, false, true)
        }
    };
    if !valid || disabled || user_id == 0 {
        tracing::warn!(%username, "sign-in failed");
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "bad_credentials", "wrong name or password"));
    }
    app.limiter.reset(&user_key);
    tracing::info!(%username, "signed in");
    signed_in(&app, user_id, &headers).await
}

pub async fn logout(State(app): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    auth::end_session(&app.db, &headers).await?;
    Ok(([(header::SET_COOKIE, auth::clear_cookie())], StatusCode::NO_CONTENT).into_response())
}

#[derive(Serialize)]
struct Me {
    #[serde(flatten)]
    user: CurrentUser,
    version: &'static str,
    /// Whether media is served by the same address as the interface.
    media_same_origin: bool,
}

pub async fn me(State(app): State<AppState>, user: CurrentUser) -> Json<impl Serialize> {
    Json(Me { user, version: env!("CARGO_PKG_VERSION"), media_same_origin: app.config.media_mode == MediaMode::Same })
}

#[derive(Deserialize)]
pub struct MeUpdate {
    #[serde(default, deserialize_with = "super::double_option")]
    locale: Option<Option<String>>,
    #[serde(default)]
    current_password: Option<String>,
    #[serde(default)]
    new_password: Option<String>,
}

pub async fn update_me(
    State(app): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
    Json(body): Json<MeUpdate>,
) -> AppResult<Json<CurrentUser>> {
    let user_id = user.id;
    if let Some(new_password) = body.new_password {
        auth::validate_password(&new_password)?;
        let current = body.current_password.unwrap_or_default();
        let hash: String = app
            .db
            .read(move |conn| {
                Ok(conn.query_row("SELECT password_hash FROM users WHERE id = ?1", [user_id], |r| r.get(0))?)
            })
            .await?;
        if !auth::verify_password(current, hash).await {
            return Err(AppError::bad_request("bad_credentials", "the current password is wrong"));
        }
        let hash = auth::hash_password(new_password).await?;
        // Every other device signs in again: a password changed because it leaked shuts them out.
        let current = auth::session_hash(&headers).unwrap_or_default();
        app.db
            .write(move |conn| {
                let tx = conn.transaction()?;
                tx.execute("UPDATE users SET password_hash = ?2 WHERE id = ?1", rusqlite::params![user_id, hash])?;
                tx.execute(
                    "DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2",
                    rusqlite::params![user_id, current],
                )?;
                tx.commit()?;
                Ok(())
            })
            .await?;
        tracing::info!(user = %user.username, "password changed");
    }
    if let Some(locale) = body.locale {
        let locale = locale.filter(|locale| matches!(locale.as_str(), "en" | "fr"));
        app.db
            .write(move |conn| {
                conn.execute("UPDATE users SET locale = ?2 WHERE id = ?1", rusqlite::params![user_id, locale])?;
                Ok(())
            })
            .await?;
    }
    let user = app.db.read(move |conn| auth::load_user(conn, user_id)).await?.ok_or_else(AppError::unauthorized)?;
    Ok(Json(user))
}
