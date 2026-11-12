//! Accounts, sessions and permissions.
//!
//! Passwords are hashed with Argon2id. A session is a random token in an `HttpOnly`,
//! `SameSite=Strict` cookie; only its SHA-256 is stored. What a user may do is their role's
//! permissions, plus or minus their own exceptions. The admin role may do everything.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::password_hash::phc::PasswordHash;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use axum::extract::{FromRequestParts, Request};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, header};
use axum::middleware::Next;
use axum::response::Response;
use serde::Serialize;

use crate::app::AppState;
use crate::crypto::{random_token, sha256};
use crate::db::{Db, now_ms};
use crate::error::{AppError, AppResult};

pub const COOKIE: &str = "vixion_session";
const SESSION_DAYS: i64 = 30;

/// Every permission, in the order the interface lists them.
pub const PERMISSIONS: &[&str] = &[
    "streams.view",
    "streams.download",
    "streams.keep",
    "streams.delete",
    "streamers.manage",
    "stats.view",
    "logs.view",
    "users.manage",
    "settings.manage",
];

/// What the built-in `user` role starts with.
const USER_DEFAULTS: &[&str] = &["streams.view", "streams.download", "stats.view"];

#[derive(Debug, Clone, Serialize)]
pub struct CurrentUser {
    pub id: i64,
    pub username: String,
    pub role_id: i64,
    pub role: String,
    pub admin: bool,
    pub locale: Option<String>,
    pub permissions: BTreeSet<String>,
}

impl CurrentUser {
    pub fn can(&self, permission: &str) -> bool {
        self.admin || self.permissions.contains(permission)
    }

    pub fn require(&self, permission: &str) -> AppResult<()> {
        if self.can(permission) { Ok(()) } else { Err(AppError::forbidden()) }
    }
}

pub async fn hash_password(password: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes())
            .map(|hash| hash.to_string())
            .map_err(|error| AppError::internal(format!("hashing: {error}")))
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?
}

pub async fn verify_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .is_ok_and(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
    })
    .await
    .unwrap_or(false)
}

pub fn validate_password(password: &str) -> AppResult<()> {
    if password.chars().count() < 8 {
        return Err(AppError::bad_request("weak_password", "at least 8 characters"));
    }
    if password.len() > 256 {
        return Err(AppError::bad_request("long_password", "at most 256 bytes"));
    }
    Ok(())
}

pub fn validate_username(username: &str) -> AppResult<()> {
    let ok = (2..=32).contains(&username.chars().count())
        && username.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if ok { Ok(()) } else { Err(AppError::bad_request("invalid_username", "2 to 32 letters, digits, _ - .")) }
}

/// Creates the built-in roles if they are missing.
pub async fn seed_roles(db: &Db) -> AppResult<()> {
    db.write(|conn| {
        let now = now_ms();
        conn.execute(
            "INSERT OR IGNORE INTO roles (name, builtin, permissions, created_at) VALUES ('admin', 'admin', ?1, ?2)",
            rusqlite::params![serde_json::to_string(PERMISSIONS)?, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO roles (name, builtin, permissions, created_at) VALUES ('user', 'user', ?1, ?2)",
            rusqlite::params![serde_json::to_string(USER_DEFAULTS)?, now],
        )?;
        Ok(())
    })
    .await
}

/// Loads a user with their effective permissions.
pub fn load_user(conn: &rusqlite::Connection, user_id: i64) -> AppResult<Option<CurrentUser>> {
    let row = conn.query_row(
        "SELECT u.id, u.username, u.role_id, r.name, r.builtin, r.permissions, u.locale, u.disabled
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?1",
        [user_id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)? != 0,
            ))
        },
    );
    let (id, username, role_id, role, builtin, role_permissions, locale, disabled) = match row {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if disabled {
        return Ok(None);
    }
    let admin = builtin.as_deref() == Some("admin");
    let mut permissions: BTreeSet<String> = if admin {
        PERMISSIONS.iter().map(|p| (*p).to_owned()).collect()
    } else {
        serde_json::from_str::<Vec<String>>(&role_permissions).unwrap_or_default().into_iter().collect()
    };
    if !admin {
        let mut statement = conn.prepare_cached("SELECT permission, allow FROM user_permissions WHERE user_id = ?1")?;
        let overrides = statement.query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)))?;
        for entry in overrides {
            let (permission, allow) = entry?;
            if allow {
                permissions.insert(permission);
            } else {
                permissions.remove(&permission);
            }
        }
    }
    permissions.retain(|permission| PERMISSIONS.contains(&permission.as_str()));
    Ok(Some(CurrentUser { id, username, role_id, role, admin, locale, permissions }))
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| pair.trim().split_once('=').filter(|(key, _)| *key == name).map(|(_, v)| v.to_owned()))
}

/// Whether the browser reached us over HTTPS, directly or through a proxy such as Cloudflare.
pub fn is_https(headers: &HeaderMap) -> bool {
    headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).is_some_and(|v| v.eq_ignore_ascii_case("https"))
        || headers.get("cf-visitor").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("https"))
}

pub fn session_cookie(token: &str, headers: &HeaderMap) -> String {
    let secure = if is_https(headers) { "; Secure" } else { "" };
    format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{secure}", SESSION_DAYS * 86_400)
}

pub fn clear_cookie() -> String {
    format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
}

/// Opens a session and returns its cookie token.
pub async fn create_session(db: &Db, user_id: i64, user_agent: Option<String>) -> AppResult<String> {
    let token = random_token();
    let hash = sha256(token.as_bytes());
    db.write(move |conn| {
        let now = now_ms();
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![hash, user_id, now, now + SESSION_DAYS * 86_400_000, user_agent],
        )?;
        conn.execute("UPDATE users SET last_login_at = ?2 WHERE id = ?1", rusqlite::params![user_id, now])?;
        conn.execute("DELETE FROM sessions WHERE expires_at < ?1", [now])?;
        Ok(())
    })
    .await?;
    Ok(token)
}

pub async fn end_session(db: &Db, headers: &HeaderMap) -> AppResult<()> {
    let Some(token) = cookie_value(headers, COOKIE) else { return Ok(()) };
    let hash = sha256(token.as_bytes());
    db.write(move |conn| {
        conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [hash])?;
        Ok(())
    })
    .await
}

/// The signed-in user, from the session cookie.
pub async fn user_from_headers(app: &AppState, headers: &HeaderMap) -> AppResult<CurrentUser> {
    let token = cookie_value(headers, COOKIE).ok_or_else(AppError::unauthorized)?;
    let hash = sha256(token.as_bytes());
    let user = app
        .db
        .read(move |conn| {
            let user_id: Option<i64> = conn
                .query_row(
                    "SELECT user_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
                    rusqlite::params![hash, now_ms()],
                    |row| row.get(0),
                )
                .ok();
            match user_id {
                Some(id) => load_user(conn, id),
                None => Ok(None),
            }
        })
        .await?;
    user.ok_or_else(AppError::unauthorized)
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, app: &AppState) -> Result<Self, Self::Rejection> {
        if let Some(user) = parts.extensions.get::<Self>() {
            return Ok(user.clone());
        }
        let user = user_from_headers(app, &parts.headers).await?;
        parts.extensions.insert(user.clone());
        Ok(user)
    }
}

/// Requests that change something must carry `X-Vixion: 1`. Browsers only send a custom header
/// from pages allowed to, so another site can't make a signed-in browser act (CSRF).
pub async fn require_app_header(request: Request, next: Next) -> Result<Response, AppError> {
    let safe = matches!(*request.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe && request.headers().get("x-vixion").is_none() {
        return Err(AppError::forbidden());
    }
    Ok(next.run(request).await)
}

/// Slows down password guessing: a few attempts per address and per account, then a pause.
pub struct LoginLimiter {
    attempts: Mutex<HashMap<String, (u32, Instant)>>,
}

const WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_PER_KEY: u32 = 10;

impl LoginLimiter {
    pub fn new() -> Self {
        Self { attempts: Mutex::new(HashMap::new()) }
    }

    /// Records an attempt; false when one of the keys is over its limit.
    pub fn allow(&self, keys: &[String]) -> bool {
        let Ok(mut attempts) = self.attempts.lock() else { return true };
        attempts.retain(|_, (_, since)| since.elapsed() < WINDOW);
        let blocked = keys.iter().any(|key| attempts.get(key).is_some_and(|(count, _)| *count >= MAX_PER_KEY));
        if !blocked {
            for key in keys {
                attempts.entry(key.clone()).or_insert((0, Instant::now())).0 += 1;
            }
        }
        !blocked
    }

    /// A successful sign-in clears the account's count.
    pub fn reset(&self, key: &str) {
        if let Ok(mut attempts) = self.attempts.lock() {
            attempts.remove(key);
        }
    }
}

impl Default for LoginLimiter {
    fn default() -> Self {
        Self::new()
    }
}

/// The client's address: Cloudflare's header when present, else the proxy's, else the socket's.
pub fn client_ip(headers: &HeaderMap, peer: Option<std::net::SocketAddr>) -> String {
    headers
        .get("cf-connecting-ip")
        .or_else(|| headers.get("x-real-ip"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .and_then(|list| list.split(',').next())
                .map(|ip| ip.trim().to_owned())
        })
        .or_else(|| peer.map(|peer| peer.ip().to_string()))
        .unwrap_or_default()
}
