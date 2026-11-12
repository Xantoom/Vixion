//! Recordings: details, signed media links, chat, keeping and deleting.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::auth::CurrentUser;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::recorder::retention::delete_stream;
use crate::recorder::storage::{self, Timeline};
use crate::twitch::chat::ChatLine;

/// Media links last this long: a long recording can be watched in one sitting.
const LINK_LIFETIME_SECS: i64 = 12 * 3600;

#[derive(Debug, Serialize)]
pub struct StreamSummary {
    id: i64,
    streamer_id: i64,
    part: i64,
    title: String,
    game: Option<String>,
    status: String,
    started_at: i64,
    ended_at: Option<i64>,
    duration_ms: i64,
    size_bytes: i64,
    video_codec: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
    fps: Option<f64>,
    chat_messages: i64,
    ads_skipped_ms: i64,
    keep_forever: bool,
    has_thumbnail: bool,
    /// When retention removes it, unless kept; null when it is kept or retention is off.
    expires_at: Option<i64>,
}

pub const SUMMARY_COLUMNS: &str = "s.id, s.streamer_id, s.part, s.title, s.game, s.status, s.started_at, s.ended_at,
    s.duration_ms, s.size_bytes, s.video_codec, s.width, s.height, s.fps, s.chat_messages, s.ads_skipped_ms,
    s.keep_forever, s.has_thumbnail,
    (SELECT COALESCE(st.retention_days, -1) FROM streamers st WHERE st.id = s.streamer_id)";

pub fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StreamSummary> {
    let keep_forever = row.get::<_, i64>(16)? != 0;
    let started_at: i64 = row.get(6)?;
    let own_retention: i64 = row.get(18)?;
    let retention = if own_retention >= 0 { own_retention } else { global_retention() };
    Ok(StreamSummary {
        id: row.get(0)?,
        streamer_id: row.get(1)?,
        part: row.get(2)?,
        title: row.get(3)?,
        game: row.get(4)?,
        status: row.get(5)?,
        started_at,
        ended_at: row.get(7)?,
        duration_ms: row.get(8)?,
        size_bytes: row.get(9)?,
        video_codec: row.get(10)?,
        width: row.get(11)?,
        height: row.get(12)?,
        fps: row.get(13)?,
        chat_messages: row.get(14)?,
        ads_skipped_ms: row.get(15)?,
        keep_forever,
        has_thumbnail: row.get::<_, i64>(17)? != 0,
        expires_at: (!keep_forever && retention > 0).then_some(started_at + retention * 86_400_000),
    })
}

/// The global retention, cached for row mapping (refreshed by every settings read in the API).
static GLOBAL_RETENTION: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(14);

fn global_retention() -> i64 {
    GLOBAL_RETENTION.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn set_global_retention(days: u32) {
    GLOBAL_RETENTION.store(i64::from(days), std::sync::atomic::Ordering::Relaxed);
}

#[derive(Serialize)]
struct Chapter {
    at_ms: i64,
    title: String,
    game: Option<String>,
}

#[derive(Serialize)]
pub struct StreamDetail {
    #[serde(flatten)]
    summary: StreamSummary,
    streamer_login: String,
    streamer_name: String,
    streamer_avatar: Option<String>,
    audio_codec: Option<String>,
    gaps: i64,
    error: Option<String>,
    chapters: Vec<Chapter>,
    /// Signed links on the media origin.
    video_url: String,
    download_url: Option<String>,
    /// Other parts of the same broadcast, in order.
    parts: Vec<(i64, i64)>,
}

struct Located {
    dir: PathBuf,
    part: i64,
    status: String,
    started_at: i64,
    duration_ms: i64,
    login: String,
    title: String,
}

async fn locate(app: &AppState, id: i64) -> AppResult<Located> {
    let root = app.config.streams_dir();
    let (dir, part, status, started_at, duration_ms, login, title) = app
        .db
        .read(move |conn| {
            Ok(conn.query_row(
                "SELECT s.dir, s.part, s.status, s.started_at, s.duration_ms, st.login, s.title
                 FROM streams s JOIN streamers st ON st.id = s.streamer_id WHERE s.id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )?)
        })
        .await?;
    let dir = storage::stream_dir(&root, &dir).ok_or_else(AppError::not_found)?;
    Ok(Located { dir, part, status, started_at, duration_ms, login, title })
}

/// A file name people recognise: `login_2026-11-12_title.ext`.
fn download_name(located: &Located, extension: &str) -> String {
    let title: String = located
        .title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|word| !word.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("_");
    let date = storage::folder_stamp(located.started_at);
    let part = if located.part > 1 { format!("_part{}", located.part) } else { String::new() };
    let title = if title.is_empty() { String::new() } else { format!("_{title}") };
    format!("{}_{}{part}{title}.{extension}", located.login, &date[..10])
}

pub fn media_link(app: &AppState, id: i64, name: &str, download: bool) -> String {
    let expires = now_ms() / 1000 + LINK_LIFETIME_SECS;
    let resource = format!("video:{id}");
    let signature = app.keys.sign_media(&resource, expires);
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!(
        "{}/media/{id}/{expires}/{signature}/{encoded}{}",
        app.config.media_public_url,
        if download { "?dl=1" } else { "" }
    )
}

pub async fn detail(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> AppResult<Json<StreamDetail>> {
    user.require("streams.view")?;
    set_global_retention(app.settings.get().await.retention_days);
    let (summary, login, name, avatar, audio_codec, gaps, error, chapters, parts) = app
        .db
        .read(move |conn| {
            let summary = conn.query_row(
                &format!("SELECT {SUMMARY_COLUMNS} FROM streams s WHERE s.id = ?1"),
                [id],
                summary_from_row,
            )?;
            let (login, name, avatar, audio_codec, gaps, error, dir): (
                String,
                String,
                Option<String>,
                Option<String>,
                i64,
                Option<String>,
                String,
            ) = conn.query_row(
                "SELECT st.login, st.display_name, st.avatar_url, s.audio_codec, s.gaps, s.error, s.dir
                     FROM streams s JOIN streamers st ON st.id = s.streamer_id WHERE s.id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            )?;
            let mut statement = conn
                .prepare_cached("SELECT at_ms, title, game FROM stream_chapters WHERE stream_id = ?1 ORDER BY at_ms")?;
            let chapters = statement
                .query_map([id], |row| Ok(Chapter { at_ms: row.get(0)?, title: row.get(1)?, game: row.get(2)? }))?
                .collect::<Result<Vec<_>, _>>()?;
            let mut statement = conn.prepare_cached("SELECT id, part FROM streams WHERE dir = ?1 ORDER BY part")?;
            let parts =
                statement.query_map([dir], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            Ok((summary, login, name, avatar, audio_codec, gaps, error, chapters, parts))
        })
        .await?;
    let located = locate(&app, id).await?;
    let file = download_name(&located, "mp4");
    Ok(Json(StreamDetail {
        video_url: media_link(&app, id, &file, false),
        download_url: user.can("streams.download").then(|| media_link(&app, id, &file, true)),
        summary,
        streamer_login: login,
        streamer_name: name,
        streamer_avatar: avatar,
        audio_codec,
        gaps,
        error,
        chapters,
        parts,
    }))
}

#[derive(Deserialize)]
pub struct StreamUpdate {
    keep_forever: bool,
}

pub async fn update(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Json(body): Json<StreamUpdate>,
) -> AppResult<StatusCode> {
    user.require("streams.keep")?;
    let changed = app
        .db
        .write(move |conn| {
            Ok(conn.execute(
                "UPDATE streams SET keep_forever = ?2 WHERE id = ?1",
                rusqlite::params![id, body.keep_forever],
            )?)
        })
        .await?;
    tracing::info!(id, keep = body.keep_forever, by = %user.username, "retention changed");
    if changed == 0 { Err(AppError::not_found()) } else { Ok(StatusCode::NO_CONTENT) }
}

pub async fn remove(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<StatusCode> {
    user.require("streams.delete")?;
    let located = locate(&app, id).await?;
    if located.status == "recording" {
        return Err(AppError::conflict("recording", "stop the recording first"));
    }
    delete_stream(&app, id).await?;
    tracing::info!(id, by = %user.username, "recording deleted");
    Ok(StatusCode::NO_CONTENT)
}

pub async fn thumbnail(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<Response> {
    user.require("streams.view")?;
    let located = locate(&app, id).await?;
    let bytes = tokio::fs::read(located.dir.join(storage::THUMBNAIL_FILE)).await?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=300")], bytes).into_response())
}

/// A chat line with its time in the video.
#[derive(Debug, Clone, Serialize)]
pub struct TimedLine {
    /// Video time, milliseconds.
    o: i64,
    #[serde(flatten)]
    line: ChatLine,
}

type ChatCache = Mutex<HashMap<(i64, u64), Arc<Vec<TimedLine>>>>;

fn cache() -> &'static ChatCache {
    static CACHE: OnceLock<ChatCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The recording's chat in video time, cached while the file doesn't change.
async fn timed_chat(id: i64, located: &Located) -> AppResult<Arc<Vec<TimedLine>>> {
    let chat_path = located.dir.join(storage::CHAT_FILE);
    let size = match tokio::fs::metadata(&chat_path).await {
        Ok(meta) => meta.len(),
        Err(_) => return Ok(Arc::new(Vec::new())),
    };
    if let Some(found) = cache().lock().ok().and_then(|cache| cache.get(&(id, size)).cloned()) {
        return Ok(found);
    }
    let timeline_path = located.dir.join(storage::timeline_file(located.part));
    let limit = located.duration_ms + 5_000;
    let recording = located.status == "recording";
    let lines = tokio::task::spawn_blocking(move || -> Vec<TimedLine> {
        let timeline = Timeline::load(&timeline_path);
        let Ok(text) = std::fs::read_to_string(&chat_path) else { return Vec::new() };
        let mut lines: Vec<TimedLine> = text
            .lines()
            .filter_map(|line| serde_json::from_str::<ChatLine>(line).ok())
            .filter_map(|line| {
                let o = timeline.video_time(line.t)?;
                (recording || o <= limit).then_some(TimedLine { o, line })
            })
            .collect();
        lines.sort_by_key(|line| line.o);
        lines
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?;
    let lines = Arc::new(lines);
    if let Ok(mut cache) = cache().lock() {
        cache.retain(|(cached, _), _| *cached != id);
        if cache.len() >= 6 {
            cache.clear();
        }
        cache.insert((id, size), Arc::clone(&lines));
    }
    Ok(lines)
}

#[derive(Deserialize)]
pub struct Window {
    /// Video milliseconds, inclusive.
    from: i64,
    /// Video milliseconds, exclusive.
    to: i64,
}

/// Chat between two video times; the player asks a few minutes at a time.
pub async fn chat_window(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Query(window): Query<Window>,
) -> AppResult<Response> {
    user.require("streams.view")?;
    let located = locate(&app, id).await?;
    let lines = timed_chat(id, &located).await?;
    let start = lines.partition_point(|line| line.o < window.from);
    let end = lines.partition_point(|line| line.o < window.to.min(window.from + 30 * 60_000));
    let slice = &lines[start..end.max(start)];
    let cache = if located.status == "recording" { "no-store" } else { "private, max-age=3600" };
    Ok(([(header::CACHE_CONTROL, cache)], Json(slice)).into_response())
}

fn attachment(name: &str) -> String {
    let ascii: String = name.chars().map(|c| if c.is_ascii_graphic() && c != '"' { c } else { '_' }).collect();
    format!("attachment; filename=\"{ascii}\"")
}

pub async fn chat_json(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<Response> {
    user.require("streams.download")?;
    let located = locate(&app, id).await?;
    let lines = timed_chat(id, &located).await?;
    let body = serde_json::to_vec(&serde_json::json!({
        "channel": located.login,
        "title": located.title,
        "started_at": located.started_at,
        "messages": &*lines,
    }))?;
    let name = download_name(&located, "chat.json");
    Ok((
        [(header::CONTENT_TYPE, "application/json".to_owned()), (header::CONTENT_DISPOSITION, attachment(&name))],
        body,
    )
        .into_response())
}

fn ass_time(ms: i64) -> String {
    let cs = ms.max(0) / 10;
    format!("{}:{:02}:{:02}.{:02}", cs / 360_000, cs / 6000 % 60, cs / 100 % 60, cs % 100)
}

/// `#RRGGBB` as ASS's `&HBBGGRR&`.
fn ass_color(hex: &str) -> Option<String> {
    let hex = hex.strip_prefix('#')?;
    (hex.len() == 6).then(|| format!("&H{}{}{}&", &hex[4..6], &hex[2..4], &hex[0..2]))
}

/// The chat as subtitles, for players such as VLC or mpv: each message shows for a few
/// seconds at the bottom left, the newest under the others.
pub async fn chat_ass(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<Response> {
    user.require("streams.download")?;
    let located = locate(&app, id).await?;
    let lines = timed_chat(id, &located).await?;
    let mut out = String::with_capacity(lines.len() * 96 + 1024);
    out.push_str(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, \
         Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, \
         MarginR, MarginV, Encoding\n\
         Style: Chat,Inter,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,1,40,1100,40,1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
    );
    for line in lines.iter().filter(|line| matches!(line.line.k.as_str(), "m" | "a" | "n")) {
        let name = if line.line.n.is_empty() { &line.line.u } else { &line.line.n };
        let text = if line.line.k == "n" && line.line.m.is_empty() { &line.line.s } else { &line.line.m };
        let clean = |s: &str| s.replace(['{', '}'], "").replace('\n', " ");
        let color = ass_color(&line.line.c).map(|c| format!("{{\\c{c}}}")).unwrap_or_default();
        let _ = writeln!(
            out,
            "Dialogue: 0,{},{},Chat,,0,0,0,,{color}{{\\b1}}{}{{\\b0\\c&HFFFFFF&}}: {}",
            ass_time(line.o),
            ass_time(line.o + 8_000),
            clean(name),
            clean(text)
        );
    }
    let name = download_name(&located, "chat.ass");
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/x-ssa; charset=utf-8".to_owned()),
            (header::CONTENT_DISPOSITION, attachment(&name)),
        ],
        out,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_subtitle_times_and_colours() {
        assert_eq!(ass_time(3_723_450), "1:02:03.45");
        assert_eq!(ass_color("#FF4500").as_deref(), Some("&H0045FF&"));
    }
}
