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

/// Argon2 takes about 19 MB and a few tens of milliseconds per hash: a few at a time, so a flood of
/// sign-ins waits its turn instead of filling memory and the threads the database needs.
fn hashing() -> &'static tokio::sync::Semaphore {
    static SLOTS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| tokio::sync::Semaphore::new(2))
}

pub async fn hash_password(password: String) -> AppResult<String> {
    let _slot = hashing().acquire().await.map_err(|error| AppError::internal(error.to_string()))?;
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
    let Ok(_slot) = hashing().acquire().await else { return false };
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

/// On an install without accounts, makes the setup code and prints it where only the server's
/// owner looks: its log.
pub async fn announce_setup(app: &AppState) -> AppResult<()> {
    let users: i64 =
        app.db.read(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?)).await?;
    if users > 0 {
        return Ok(());
    }
    // No 0, O, 1, I or L: read off a screen and typed without doubt.
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let code: String = crate::crypto::random_bytes::<8>()
        .iter()
        .enumerate()
        .flat_map(|(at, byte)| {
            let dash = (at == 4).then_some('-');
            dash.into_iter().chain(std::iter::once(char::from(ALPHABET[usize::from(*byte) % ALPHABET.len()])))
        })
        .collect();
    tracing::warn!("no account yet: open the interface and enter the setup code {code}");
    if let Ok(mut slot) = app.setup_code.lock() {
        *slot = Some(code);
    }
    Ok(())
}

/// Loads a user with their effective permissions; None for a disabled account.
pub fn load_user(conn: &rusqlite::Connection, user_id: i64) -> AppResult<Option<CurrentUser>> {
    Ok(load_account(conn, user_id)?.filter(|(_, disabled)| !disabled).map(|(user, _)| user))
}

/// Loads an account, enabled or not, with its effective permissions and whether it is disabled.
pub fn load_account(conn: &rusqlite::Connection, user_id: i64) -> AppResult<Option<(CurrentUser, bool)>> {
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
    let admin = builtin.as_deref() == Some("admin");
    let mut statement = conn.prepare_cached("SELECT permission, allow FROM user_permissions WHERE user_id = ?1")?;
    let overrides = statement
        .query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)))?
        .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
    let permissions = effective_permissions(admin, &role_permissions, &overrides);
    Ok(Some((CurrentUser { id, username, role_id, role, admin, locale, permissions }, disabled)))
}

/// A role's permissions (a JSON list), plus or minus one person's exceptions. Everything for admins.
pub fn effective_permissions(
    admin: bool,
    role_permissions: &str,
    overrides: &std::collections::BTreeMap<String, bool>,
) -> BTreeSet<String> {
    if admin {
        return PERMISSIONS.iter().map(|p| (*p).to_owned()).collect();
    }
    let mut permissions: BTreeSet<String> =
        serde_json::from_str::<Vec<String>>(role_permissions).unwrap_or_default().into_iter().collect();
    for (permission, allow) in overrides {
        if *allow {
            permissions.insert(permission.clone());
        } else {
            permissions.remove(permission);
        }
    }
    permissions.retain(|permission| PERMISSIONS.contains(&permission.as_str()));
    permissions
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

/// The stored form of the session cookie the request carries.
pub fn session_hash(headers: &HeaderMap) -> Option<Vec<u8>> {
    cookie_value(headers, COOKIE).map(|token| sha256(token.as_bytes()))
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

/// Slows down password guessing: a few attempts per address, more per account (so that one
/// address can't lock an account by itself), then a pause.
pub struct LoginLimiter {
    attempts: Mutex<HashMap<String, (u32, Instant)>>,
}

const WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_PER_ADDRESS: u32 = 10;
const MAX_PER_ACCOUNT: u32 = 30;
/// Keys remembered at most: past this, new keys count as blocked until old ones expire.
const MAX_KEYS: usize = 10_000;

impl LoginLimiter {
    pub fn new() -> Self {
        Self { attempts: Mutex::new(HashMap::new()) }
    }

    /// Records an attempt; false when one of the keys is over its limit.
    pub fn allow(&self, keys: &[String]) -> bool {
        let Ok(mut attempts) = self.attempts.lock() else { return true };
        attempts.retain(|_, (_, since)| since.elapsed() < WINDOW);
        let limit = |key: &str| if key.starts_with("user:") { MAX_PER_ACCOUNT } else { MAX_PER_ADDRESS };
        let full = attempts.len() + keys.len() > MAX_KEYS && keys.iter().any(|key| !attempts.contains_key(key));
        let blocked = full || keys.iter().any(|key| attempts.get(key).is_some_and(|(count, _)| *count >= limit(key)));
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

/// The client's address. Behind a trusted proxy, Cloudflare's header or the proxy's; otherwise
/// the socket's, since anyone can send those headers.
pub fn client_ip(headers: &HeaderMap, peer: Option<std::net::SocketAddr>, trust_proxy: bool) -> String {
    let peer = peer.map(|peer| peer.ip().to_string());
    if !trust_proxy {
        return peer.unwrap_or_default();
    }
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
        .or(peer)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_headers_count_only_when_trusted() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9".parse().expect("header"));
        let peer = Some(std::net::SocketAddr::from(([192, 168, 1, 5], 40000)));
        assert_eq!(client_ip(&headers, peer, false), "192.168.1.5");
        assert_eq!(client_ip(&headers, peer, true), "203.0.113.9");
    }

    #[test]
    fn one_address_cannot_lock_an_account() {
        let limiter = LoginLimiter::new();
        let account = "user:admin".to_owned();
        for _ in 0..MAX_PER_ADDRESS {
            assert!(limiter.allow(&["ip:a".to_owned(), account.clone()]));
        }
        assert!(!limiter.allow(&["ip:a".to_owned(), account.clone()]));
        // Another address still gets through: the account's own limit is higher.
        assert!(limiter.allow(&["ip:b".to_owned(), account]));
    }

    #[test]
    fn exceptions_change_role_permissions() {
        let overrides = [("streams.delete".to_owned(), true), ("stats.view".to_owned(), false)].into();
        let permissions = effective_permissions(false, r#"["streams.view","stats.view","made.up"]"#, &overrides);
        assert_eq!(permissions.into_iter().collect::<Vec<_>>(), ["streams.delete", "streams.view"]);
    }
}
