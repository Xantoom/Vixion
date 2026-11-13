//! Streamers: the channels watched, with what was recorded of them.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::streams::{SUMMARY_COLUMNS, StreamSummary, summary_from_row};
use crate::app::AppState;
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::recorder::LiveProgress;
use crate::recorder::retention::delete_stream;
use crate::twitch::api::{Profile, SearchHit, valid_login};

#[derive(Debug, Serialize)]
pub struct Streamer {
    id: i64,
    twitch_id: String,
    login: String,
    display_name: String,
    avatar_url: Option<String>,
    banner_url: Option<String>,
    /// The newest recording with a picture, for the streamer's cover.
    cover_stream_id: Option<i64>,
    monitored: bool,
    retention_days: Option<i64>,
    /// How many days recordings stay when the streamer has no rule of its own; 0 keeps them.
    default_retention_days: i64,
    live: Option<LiveInfo>,
    recording: Option<LiveProgress>,
    stream_count: i64,
    total_bytes: i64,
    total_duration_ms: i64,
    last_stream_at: Option<i64>,
    created_at: i64,
}

#[derive(Debug, Serialize)]
struct LiveInfo {
    title: Option<String>,
    game: Option<String>,
    viewers: Option<i64>,
    since: i64,
}

const STREAMER_QUERY: &str = "SELECT st.id, st.twitch_id, st.login, st.display_name, st.avatar_url, st.monitored,
    st.retention_days, st.live_title, st.live_game, st.live_since, st.created_at,
    COUNT(s.id), COALESCE(SUM(s.size_bytes), 0), COALESCE(SUM(s.duration_ms), 0), MAX(s.started_at),
    st.banner_url, st.live_viewers,
    (SELECT c.id FROM streams c WHERE c.streamer_id = st.id AND c.has_thumbnail ORDER BY c.started_at DESC LIMIT 1)
    FROM streamers st LEFT JOIN streams s ON s.streamer_id = st.id";

fn streamer_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Streamer> {
    let live_since: Option<i64> = row.get(9)?;
    Ok(Streamer {
        id: row.get(0)?,
        twitch_id: row.get(1)?,
        login: row.get(2)?,
        display_name: row.get(3)?,
        avatar_url: row.get(4)?,
        banner_url: row.get(15)?,
        cover_stream_id: row.get(17)?,
        monitored: row.get::<_, i64>(5)? != 0,
        retention_days: row.get(6)?,
        default_retention_days: super::streams::global_retention(),
        live: live_since.map(|since| LiveInfo {
            title: row.get(7).ok().flatten(),
            game: row.get(8).ok().flatten(),
            viewers: row.get(16).ok().flatten(),
            since,
        }),
        recording: None,
        created_at: row.get(10)?,
        stream_count: row.get(11)?,
        total_bytes: row.get(12)?,
        total_duration_ms: row.get(13)?,
        last_stream_at: row.get(14)?,
    })
}

/// Every streamer, alphabetically.
pub async fn list(State(app): State<AppState>, user: CurrentUser) -> AppResult<Json<Vec<Streamer>>> {
    user.require("streams.view")?;
    let mut streamers = app
        .db
        .read(|conn| {
            let mut statement = conn
                .prepare_cached(&format!("{STREAMER_QUERY} GROUP BY st.id ORDER BY st.display_name COLLATE NOCASE"))?;
            let rows = statement.query_map([], streamer_from_row)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    let live = app.recorder.live();
    for streamer in &mut streamers {
        streamer.recording = live.get(&streamer.id).cloned();
    }
    Ok(Json(streamers))
}

/// Twitch profiles, kept a minute: an open channel page refreshes often, and every viewer of it
/// would otherwise ask Twitch again, outside the pace the recorder keeps.
async fn cached_profile(app: &AppState, login: &str) -> Option<Profile> {
    type Profiles = std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Option<Profile>)>>;
    static PROFILES: std::sync::OnceLock<Profiles> = std::sync::OnceLock::new();
    const KEEP: std::time::Duration = std::time::Duration::from_secs(60);
    let profiles = PROFILES.get_or_init(Default::default);
    if let Some((_, profile)) =
        profiles.lock().ok().and_then(|map| map.get(login).filter(|(at, _)| at.elapsed() < KEEP).cloned())
    {
        return profile;
    }
    match app.twitch.profile(login).await {
        Ok(profile) => {
            if let Ok(mut map) = profiles.lock() {
                map.retain(|_, (at, _)| at.elapsed() < KEEP);
                if map.len() < 500 {
                    map.insert(login.to_owned(), (std::time::Instant::now(), profile.clone()));
                }
            }
            profile
        }
        Err(error) => {
            tracing::debug!(%error, %login, "no Twitch profile");
            None
        }
    }
}

#[derive(Serialize)]
pub struct ChannelPage {
    /// What Twitch says of the channel; null when Twitch can't be reached.
    profile: Option<Profile>,
    /// The channel as watched here; null when it isn't.
    streamer: Option<Streamer>,
    streams: Vec<StreamSummary>,
}

/// A channel's page by its login: Twitch's profile, and what was recorded of it if it is watched.
pub async fn channel(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(login): Path<String>,
) -> AppResult<Json<ChannelPage>> {
    user.require("streams.view")?;
    let login = login.to_ascii_lowercase();
    if !valid_login(&login) {
        return Err(AppError::not_found());
    }
    let key = login.clone();
    let (local, profile) = tokio::join!(
        app.db.read(move |conn| {
            let streamer = conn
                .query_row(&format!("{STREAMER_QUERY} WHERE st.login = ?1 GROUP BY st.id"), [&key], streamer_from_row)
                .optional()?;
            let Some(streamer) = streamer else { return Ok((None, Vec::new())) };
            let mut statement = conn.prepare_cached(&format!(
                "SELECT {SUMMARY_COLUMNS} FROM streams s WHERE s.streamer_id = ?1 ORDER BY s.started_at DESC, s.part DESC"
            ))?;
            let rows = statement.query_map([streamer.id], summary_from_row)?;
            Ok((Some(streamer), rows.collect::<Result<Vec<_>, _>>()?))
        }),
        cached_profile(&app, &login),
    );
    let (mut streamer, streams) = local?;
    if streamer.is_none() && profile.is_none() {
        return Err(AppError::not_found());
    }
    if let Some(streamer) = &mut streamer {
        streamer.recording = app.recorder.live().remove(&streamer.id);
    }
    Ok(Json(ChannelPage { profile, streamer, streams }))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

/// Twitch channels matching what is typed in the search box.
pub async fn search(
    State(app): State<AppState>,
    user: CurrentUser,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<Vec<SearchHit>>> {
    user.require("streams.view")?;
    let q = query.q.trim();
    if q.is_empty() || q.len() > 50 {
        return Ok(Json(Vec::new()));
    }
    let hits = app
        .twitch
        .search(q)
        .await
        .map_err(|error| AppError::new(StatusCode::BAD_GATEWAY, "upstream", error.to_string()))?;
    Ok(Json(hits))
}

/// Badge pictures and third-party emotes for a recording's chat.
pub async fn chat_assets(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(stream_id): Path<i64>,
) -> AppResult<Response> {
    user.require("streams.view")?;
    let channel_id: String = app
        .db
        .read(move |conn| {
            Ok(conn.query_row(
                "SELECT st.twitch_id FROM streams s JOIN streamers st ON st.id = s.streamer_id WHERE s.id = ?1",
                [stream_id],
                |row| row.get(0),
            )?)
        })
        .await?;
    let assets = app.chat_assets.get(&app.twitch, &app.http, &channel_id).await;
    Ok(Json(&*assets).into_response())
}

#[derive(Deserialize)]
pub struct NewStreamer {
    login: String,
}

/// Starts watching a channel, by the name in its URL (or the URL itself).
pub async fn add(
    State(app): State<AppState>,
    user: CurrentUser,
    Json(body): Json<NewStreamer>,
) -> AppResult<(StatusCode, Json<Streamer>)> {
    user.require("streamers.manage")?;
    let login = body
        .login
        .trim()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim_start_matches('@')
        .to_ascii_lowercase();
    if !valid_login(&login) {
        return Err(AppError::bad_request("invalid_login", "not a Twitch channel name"));
    }
    let channel = app
        .twitch
        .channel_by_login(&login)
        .await
        .map_err(|error| AppError::new(StatusCode::BAD_GATEWAY, "upstream", error.to_string()))?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "unknown_channel", "no such Twitch channel"))?;
    let id = app
        .db
        .write(move |conn| {
            conn.execute(
                "INSERT INTO streamers (twitch_id, login, display_name, avatar_url, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![channel.id, channel.login, channel.display_name, channel.profile_image_url, now_ms()],
            )?;
            Ok(conn.last_insert_rowid())
        })
        .await?;
    tracing::info!(%login, by = %user.username, "streamer added");
    crate::audit::record(&app, &user, "streamer.add", &login).await;
    app.recorder.check_now();
    let streamer = app
        .db
        .read(move |conn| {
            Ok(conn.query_row(&format!("{STREAMER_QUERY} WHERE st.id = ?1 GROUP BY st.id"), [id], streamer_from_row)?)
        })
        .await?;
    Ok((StatusCode::CREATED, Json(streamer)))
}

#[derive(Deserialize)]
pub struct StreamerUpdate {
    #[serde(default)]
    monitored: Option<bool>,
    #[serde(default, deserialize_with = "super::double_option")]
    retention_days: Option<Option<u32>>,
}

pub async fn update(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<StreamerUpdate>,
) -> AppResult<StatusCode> {
    user.require("streamers.manage")?;
    let changed = app
        .db
        .write(move |conn| {
            let mut changed = 0;
            if let Some(monitored) = body.monitored {
                changed += conn
                    .execute("UPDATE streamers SET monitored = ?2 WHERE id = ?1", rusqlite::params![id, monitored])?;
            }
            if let Some(days) = body.retention_days {
                changed += conn.execute(
                    "UPDATE streamers SET retention_days = ?2 WHERE id = ?1",
                    rusqlite::params![id, days.map(|d| d.min(3650))],
                )?;
            }
            Ok(changed)
        })
        .await?;
    match body.monitored {
        Some(false) => app.recorder.stop(id),
        // Turned back on during a broadcast: that broadcast is recorded again.
        Some(true) => app.recorder.resume(id),
        None => {}
    }
    app.recorder.check_now();
    if changed == 0 { Err(AppError::not_found()) } else { Ok(StatusCode::NO_CONTENT) }
}

#[derive(Deserialize)]
pub struct RemoveQuery {
    #[serde(default)]
    recordings: bool,
}

/// Stops watching a streamer. With `?recordings=true` their recordings go too, even kept ones.
pub async fn remove(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Query(query): Query<RemoveQuery>,
) -> AppResult<StatusCode> {
    user.require("streamers.manage")?;
    if query.recordings && !user.can("streams.delete") {
        return Err(AppError::forbidden());
    }
    // No new recording may start while the streamer goes: monitoring stops first.
    let was_monitored: bool = app
        .db
        .write(move |conn| {
            let monitored: i64 =
                conn.query_row("SELECT monitored FROM streamers WHERE id = ?1", [id], |row| row.get(0))?;
            conn.execute("UPDATE streamers SET monitored = 0 WHERE id = ?1", [id])?;
            Ok(monitored != 0)
        })
        .await?;
    let restore = async || {
        let _ = app
            .db
            .write(move |conn| {
                conn.execute(
                    "UPDATE streamers SET monitored = ?2 WHERE id = ?1",
                    rusqlite::params![id, was_monitored],
                )?;
                Ok(())
            })
            .await;
    };
    if app.recorder.is_recording(id) {
        restore().await;
        return Err(AppError::conflict("recording", "stop the recording first"));
    }
    let streams: Vec<i64> = app
        .db
        .read(move |conn| {
            let mut statement = conn.prepare("SELECT id FROM streams WHERE streamer_id = ?1")?;
            let rows = statement.query_map([id], |row| row.get(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    if !streams.is_empty() && !query.recordings {
        restore().await;
        return Err(AppError::conflict("has_recordings", "this streamer still has recordings"));
    }
    for stream in streams {
        delete_stream(&app, stream).await?;
    }
    app.db
        .write(move |conn| {
            conn.execute("DELETE FROM streamers WHERE id = ?1", [id])?;
            Ok(())
        })
        .await?;
    tracing::info!(id, by = %user.username, "streamer removed");
    crate::audit::record(&app, &user, "streamer.remove", id.to_string()).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Stops the recording in progress, keeping what was recorded.
pub async fn stop(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<StatusCode> {
    user.require("streamers.manage")?;
    if !app.recorder.is_recording(id) {
        return Err(AppError::conflict("not_recording", "nothing is being recorded"));
    }
    app.recorder.stop(id);
    tracing::info!(id, by = %user.username, "recording stopped by hand");
    crate::audit::record(&app, &user, "recording.stop", id.to_string()).await;
    Ok(StatusCode::NO_CONTENT)
}
