//! Administration: statistics, settings, users, roles, logs and alerts.

use std::collections::BTreeMap;
use std::convert::Infallible;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::alerts::Alert;
use crate::app::AppState;
use crate::auth::{self, CurrentUser, PERMISSIONS};
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::logs::LogEntry;
use crate::settings::Settings;
use crate::system;

#[derive(Serialize)]
struct StreamerStats {
    id: i64,
    login: String,
    display_name: String,
    avatar_url: Option<String>,
    streams: i64,
    bytes: i64,
    duration_ms: i64,
    kept: i64,
}

pub async fn stats(State(app): State<AppState>, user: CurrentUser) -> AppResult<Json<serde_json::Value>> {
    user.require("stats.view")?;
    let (streamers, totals) = app
        .db
        .read(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT st.id, st.login, st.display_name, st.avatar_url, COUNT(s.id), COALESCE(SUM(s.size_bytes), 0),
                 COALESCE(SUM(s.duration_ms), 0), COALESCE(SUM(s.keep_forever), 0)
                 FROM streamers st LEFT JOIN streams s ON s.streamer_id = st.id
                 GROUP BY st.id ORDER BY 6 DESC",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(StreamerStats {
                    id: row.get(0)?,
                    login: row.get(1)?,
                    display_name: row.get(2)?,
                    avatar_url: row.get(3)?,
                    streams: row.get(4)?,
                    bytes: row.get(5)?,
                    duration_ms: row.get(6)?,
                    kept: row.get(7)?,
                })
            })?;
            let streamers = rows.collect::<Result<Vec<_>, _>>()?;
            let totals: (i64, i64, i64) = conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0), COALESCE(SUM(duration_ms), 0) FROM streams",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            Ok((streamers, totals))
        })
        .await?;
    let disk = system::disk_space(&app.config.streams_dir()).unwrap_or_default();
    Ok(Json(json!({
        "streamers": streamers,
        "streams": totals.0,
        "bytes": totals.1,
        "duration_ms": totals.2,
        "recording": app.recorder.live().len(),
        "disk": disk,
        "memory": system::memory_used(),
        "uptime_ms": now_ms() - app.started_at,
        "version": env!("CARGO_PKG_VERSION"),
    })))
}

pub async fn get_settings(State(app): State<AppState>, user: CurrentUser) -> AppResult<Json<serde_json::Value>> {
    user.require("settings.manage")?;
    let settings = app.settings.get().await;
    Ok(Json(json!({
        "settings": settings,
        "system": {
            "media_mode": format!("{:?}", app.config.media_mode).to_lowercase(),
            "media_url": app.config.media_public_url,
            "data_dir": app.config.data_dir.display().to_string(),
            "recordings_dir": app.config.recordings_dir.display().to_string(),
        },
    })))
}

pub async fn put_settings(
    State(app): State<AppState>,
    user: CurrentUser,
    Json(body): Json<Settings>,
) -> AppResult<Json<Settings>> {
    user.require("settings.manage")?;
    let saved = app.settings.update(body).await?;
    super::streams::set_global_retention(saved.retention_days);
    tracing::info!(by = %user.username, "settings changed");
    crate::audit::record(&app, &user, "settings.update", "").await;
    app.recorder.check_now();
    Ok(Json(saved))
}

#[derive(Serialize)]
pub struct TokenReveal {
    token: Option<String>,
}

/// The Twitch token in clear, for an administrator who asks to see it. It is set in the
/// configuration, never from here.
pub async fn reveal_twitch_token(State(app): State<AppState>, user: CurrentUser) -> AppResult<Response> {
    user.require("settings.manage")?;
    tracing::info!(by = %user.username, "Twitch token revealed");
    crate::audit::record(&app, &user, "twitch_token.reveal", "").await;
    let token = app.settings.twitch_token().await;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(TokenReveal { token })).into_response())
}

#[derive(Serialize)]
struct UserRow {
    id: i64,
    username: String,
    role_id: i64,
    disabled: bool,
    created_at: i64,
    last_login_at: Option<i64>,
    /// Permission exceptions: true granted, false withdrawn.
    overrides: BTreeMap<String, bool>,
}

pub async fn list_users(State(app): State<AppState>, user: CurrentUser) -> AppResult<Json<Vec<serde_json::Value>>> {
    user.require("users.manage")?;
    let users = app
        .db
        .read(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT u.id, u.username, u.role_id, u.disabled, u.created_at, u.last_login_at, r.builtin, r.permissions
                 FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.username COLLATE NOCASE",
            )?;
            let mut users = statement
                .query_map([], |row| {
                    Ok((
                        UserRow {
                            id: row.get(0)?,
                            username: row.get(1)?,
                            role_id: row.get(2)?,
                            disabled: row.get::<_, i64>(3)? != 0,
                            created_at: row.get(4)?,
                            last_login_at: row.get(5)?,
                            overrides: BTreeMap::new(),
                        },
                        row.get::<_, Option<String>>(6)?.as_deref() == Some("admin"),
                        row.get::<_, String>(7)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut statement = conn.prepare_cached("SELECT user_id, permission, allow FROM user_permissions")?;
            let overrides = statement.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)? != 0))
            })?;
            let index: std::collections::HashMap<i64, usize> =
                users.iter().enumerate().map(|(at, (row, _, _))| (row.id, at)).collect();
            for entry in overrides {
                let (id, permission, allow) = entry?;
                if let Some(&at) = index.get(&id) {
                    users[at].0.overrides.insert(permission, allow);
                }
            }
            let mut out = Vec::with_capacity(users.len());
            for (row, admin, role_permissions) in users {
                let effective = auth::effective_permissions(admin, &role_permissions, &row.overrides);
                let mut value = serde_json::to_value(&row)?;
                value["permissions"] = json!(effective);
                out.push(value);
            }
            Ok(out)
        })
        .await?;
    Ok(Json(users))
}

/// Who manages accounts without being an administrator only hands out what they have themselves:
/// nobody can give anyone, themselves included, more than they hold.
fn require_within<'a>(user: &CurrentUser, permissions: impl IntoIterator<Item = &'a String>) -> AppResult<()> {
    if user.admin || permissions.into_iter().all(|permission| user.can(permission)) {
        Ok(())
    } else {
        Err(AppError::forbidden())
    }
}

/// A role: whether it is the administrator role, and its permissions.
async fn role_info(app: &AppState, role_id: i64) -> AppResult<(bool, Vec<String>)> {
    let (builtin, permissions): (Option<String>, String) = app
        .db
        .read(move |conn| {
            Ok(conn.query_row("SELECT builtin, permissions FROM roles WHERE id = ?1", [role_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?)
        })
        .await?;
    let admin = builtin.as_deref() == Some("admin");
    let permissions = if admin {
        PERMISSIONS.iter().map(|p| (*p).to_owned()).collect()
    } else {
        serde_json::from_str(&permissions).unwrap_or_default()
    };
    Ok((admin, permissions))
}

/// An account's effective permissions and role, enabled or not.
async fn account(app: &AppState, id: i64) -> AppResult<CurrentUser> {
    app.db
        .read(move |conn| auth::load_account(conn, id))
        .await?
        .map(|(account, _)| account)
        .ok_or_else(AppError::not_found)
}

#[derive(Deserialize)]
pub struct NewUser {
    username: String,
    password: String,
    role_id: i64,
}

pub async fn create_user(
    State(app): State<AppState>,
    user: CurrentUser,
    Json(body): Json<NewUser>,
) -> AppResult<StatusCode> {
    user.require("users.manage")?;
    let username = body.username.trim().to_owned();
    auth::validate_username(&username)?;
    auth::validate_password(&body.password)?;
    let role_id = body.role_id;
    let (admin_role, role_permissions) = role_info(&app, role_id).await?;
    if admin_role && !user.admin {
        return Err(AppError::forbidden());
    }
    require_within(&user, &role_permissions)?;
    let hash = auth::hash_password(body.password).await?;
    let name = username.clone();
    app.db
        .write(move |conn| {
            conn.execute(
                "INSERT INTO users (username, password_hash, role_id, created_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![name, hash, role_id, now_ms()],
            )?;
            Ok(())
        })
        .await?;
    tracing::info!(%username, by = %user.username, "user created");
    crate::audit::record(&app, &user, "user.create", &username).await;
    Ok(StatusCode::CREATED)
}

async fn active_admins(app: &AppState) -> AppResult<i64> {
    app.db
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.builtin = 'admin' AND u.disabled = 0",
                [],
                |row| row.get(0),
            )?)
        })
        .await
}

#[derive(Deserialize)]
pub struct UserUpdate {
    #[serde(default)]
    role_id: Option<i64>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    disabled: Option<bool>,
    /// Permission → true (grant), false (withdraw) or null (follow the role).
    #[serde(default)]
    overrides: Option<BTreeMap<String, Option<bool>>>,
}

pub async fn update_user(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<UserUpdate>,
) -> AppResult<StatusCode> {
    user.require("users.manage")?;
    let target = account(&app, id).await?;
    let target_role = target.role_id;
    let target_admin = target.admin;
    if !user.admin {
        // One's own permissions are changed by someone else.
        if id == user.id && (body.overrides.is_some() || body.role_id.is_some()) {
            return Err(AppError::forbidden());
        }
        // An account holding more than oneself is out of reach (its password included).
        require_within(&user, &target.permissions)?;
        let granted: Vec<String> = body
            .overrides
            .iter()
            .flatten()
            .filter(|(_, allow)| **allow == Some(true))
            .map(|(permission, _)| permission.clone())
            .collect();
        require_within(&user, &granted)?;
    }
    // Only administrators touch administrators, or make new ones.
    if (target_admin || body.role_id.is_some_and(|role| role != target_role)) && !user.admin {
        return Err(AppError::forbidden());
    }
    if let Some(role_id) = body.role_id
        && role_id != target_role
    {
        let (admin_role, role_permissions) = role_info(&app, role_id).await?;
        if admin_role && !user.admin {
            return Err(AppError::forbidden());
        }
        require_within(&user, &role_permissions)?;
    }
    let demoting =
        target_admin && (body.role_id.is_some_and(|role| role != target_role) || body.disabled == Some(true));
    if demoting && active_admins(&app).await? <= 1 {
        return Err(AppError::conflict("last_admin", "there must be at least one administrator"));
    }
    let hash = match body.password {
        Some(password) => {
            auth::validate_password(&password)?;
            Some(auth::hash_password(password).await?)
        }
        None => None,
    };
    let signs_out = hash.is_some() || body.disabled == Some(true);
    app.db
        .write(move |conn| {
            let tx = conn.transaction()?;
            if let Some(role_id) = body.role_id {
                tx.execute("UPDATE users SET role_id = ?2 WHERE id = ?1", rusqlite::params![id, role_id])?;
            }
            if let Some(hash) = hash {
                tx.execute("UPDATE users SET password_hash = ?2 WHERE id = ?1", rusqlite::params![id, hash])?;
            }
            if let Some(disabled) = body.disabled {
                tx.execute("UPDATE users SET disabled = ?2 WHERE id = ?1", rusqlite::params![id, disabled])?;
            }
            if signs_out {
                tx.execute("DELETE FROM sessions WHERE user_id = ?1", [id])?;
            }
            for (permission, allow) in body.overrides.unwrap_or_default() {
                if !PERMISSIONS.contains(&permission.as_str()) {
                    return Err(AppError::bad_request("unknown_permission", permission));
                }
                match allow {
                    Some(allow) => tx.execute(
                        "INSERT INTO user_permissions (user_id, permission, allow) VALUES (?1, ?2, ?3)
                         ON CONFLICT (user_id, permission) DO UPDATE SET allow = excluded.allow",
                        rusqlite::params![id, permission, allow],
                    )?,
                    None => tx.execute(
                        "DELETE FROM user_permissions WHERE user_id = ?1 AND permission = ?2",
                        rusqlite::params![id, permission],
                    )?,
                };
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    tracing::info!(id, by = %user.username, "user changed");
    crate::audit::record(&app, &user, "user.update", &target.username).await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_user(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<StatusCode> {
    user.require("users.manage")?;
    if id == user.id {
        return Err(AppError::conflict("self", "you can't delete your own account"));
    }
    let target = account(&app, id).await?;
    require_within(&user, &target.permissions)?;
    if target.admin {
        if !user.admin {
            return Err(AppError::forbidden());
        }
        if active_admins(&app).await? <= 1 {
            return Err(AppError::conflict("last_admin", "there must be at least one administrator"));
        }
    }
    app.db
        .write(move |conn| {
            conn.execute("DELETE FROM users WHERE id = ?1", [id])?;
            Ok(())
        })
        .await?;
    tracing::info!(id, by = %user.username, "user deleted");
    crate::audit::record(&app, &user, "user.delete", &target.username).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct Role {
    id: i64,
    name: String,
    builtin: Option<String>,
    permissions: Vec<String>,
    users: i64,
}

pub async fn list_roles(State(app): State<AppState>, user: CurrentUser) -> AppResult<Json<serde_json::Value>> {
    user.require("users.manage")?;
    let roles = app
        .db
        .read(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT r.id, r.name, r.builtin, r.permissions, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id)
                 FROM roles r ORDER BY r.builtin IS NULL, r.name COLLATE NOCASE",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(Role {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    builtin: row.get(2)?,
                    permissions: serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or_default(),
                    users: row.get(4)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    Ok(Json(json!({ "roles": roles, "permissions": PERMISSIONS })))
}

#[derive(Deserialize)]
pub struct RoleBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    permissions: Option<Vec<String>>,
}

fn clean_permissions(permissions: Vec<String>) -> AppResult<String> {
    if let Some(unknown) = permissions.iter().find(|p| !PERMISSIONS.contains(&p.as_str())) {
        return Err(AppError::bad_request("unknown_permission", unknown.clone()));
    }
    Ok(serde_json::to_string(&permissions)?)
}

fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err(AppError::bad_request("invalid_name", "1 to 40 characters"));
    }
    Ok(name.to_owned())
}

pub async fn create_role(
    State(app): State<AppState>,
    user: CurrentUser,
    Json(body): Json<RoleBody>,
) -> AppResult<StatusCode> {
    user.require("users.manage")?;
    let name = clean_name(body.name.as_deref().unwrap_or_default())?;
    let wanted = body.permissions.unwrap_or_default();
    require_within(&user, &wanted)?;
    let permissions = clean_permissions(wanted)?;
    let audited = name.clone();
    app.db
        .write(move |conn| {
            conn.execute(
                "INSERT INTO roles (name, permissions, created_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![name, permissions, now_ms()],
            )?;
            Ok(())
        })
        .await?;
    crate::audit::record(&app, &user, "role.create", audited).await;
    Ok(StatusCode::CREATED)
}

pub async fn update_role(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<RoleBody>,
) -> AppResult<StatusCode> {
    user.require("users.manage")?;
    let (admin_role, current) = role_info(&app, id).await?;
    if admin_role {
        return Err(AppError::conflict("builtin", "the administrator role can do everything"));
    }
    if !user.admin {
        // One's own role is changed by someone else; a role holding more is out of reach.
        if id == user.role_id {
            return Err(AppError::forbidden());
        }
        require_within(&user, &current)?;
        require_within(&user, body.permissions.iter().flatten())?;
    }
    let name = body.name.as_deref().map(clean_name).transpose()?;
    let permissions = body.permissions.map(clean_permissions).transpose()?;
    app.db
        .write(move |conn| {
            let builtin: Option<String> =
                conn.query_row("SELECT builtin FROM roles WHERE id = ?1", [id], |row| row.get(0))?;
            if let Some(name) = name {
                if builtin.is_some() {
                    return Err(AppError::conflict("builtin", "built-in roles keep their name"));
                }
                conn.execute("UPDATE roles SET name = ?2 WHERE id = ?1", rusqlite::params![id, name])?;
            }
            if let Some(permissions) = permissions {
                conn.execute("UPDATE roles SET permissions = ?2 WHERE id = ?1", rusqlite::params![id, permissions])?;
            }
            Ok(())
        })
        .await?;
    crate::audit::record(&app, &user, "role.update", id.to_string()).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes a custom role; its users move to the built-in `user` role.
pub async fn delete_role(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<StatusCode> {
    user.require("users.manage")?;
    let (_, current) = role_info(&app, id).await?;
    require_within(&user, &current)?;
    app.db
        .write(move |conn| {
            let tx = conn.transaction()?;
            let builtin: Option<String> =
                tx.query_row("SELECT builtin FROM roles WHERE id = ?1", [id], |row| row.get(0))?;
            if builtin.is_some() {
                return Err(AppError::conflict("builtin", "built-in roles can't be deleted"));
            }
            let fallback: i64 = tx.query_row("SELECT id FROM roles WHERE builtin = 'user'", [], |row| row.get(0))?;
            tx.execute("UPDATE users SET role_id = ?2 WHERE role_id = ?1", rusqlite::params![id, fallback])?;
            tx.execute("DELETE FROM roles WHERE id = ?1", [id])?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    crate::audit::record(&app, &user, "role.delete", id.to_string()).await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn logs(State(app): State<AppState>, user: CurrentUser) -> AppResult<Json<Vec<LogEntry>>> {
    user.require("logs.view")?;
    Ok(Json(app.logs.recent()))
}

/// New log lines as they happen, as server-sent events.
pub async fn logs_live(
    State(app): State<AppState>,
    user: CurrentUser,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    user.require("logs.view")?;
    let receiver = app.logs.subscribe();
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(entry) => {
                    let event = Event::default().json_data(&entry).unwrap_or_default();
                    return Some((Ok(event), receiver));
                }
                // Lines missed by a slow reader are skipped, not fatal.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

pub async fn alerts(State(app): State<AppState>, user: CurrentUser) -> AppResult<Json<Vec<Alert>>> {
    user.require("logs.view")?;
    Ok(Json(app.alerts.list(false).await?))
}

pub async fn dismiss_alert(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<StatusCode> {
    user.require("logs.view")?;
    app.alerts.dismiss(id).await?;
    Ok(StatusCode::NO_CONTENT)
}
