//! Recordings: details, signed media links, chat, keeping and deleting.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
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

pub(super) fn global_retention() -> i64 {
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
    /// Where the broadcast is missing from the video: (video ms, ms missing).
    cuts: Vec<(i64, i64)>,
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

/// What a media link gives access to: one recording, for one person, to watch or to download.
/// The person's rights are checked again on every request, so taking them away (or the account)
/// ends the link too.
pub fn media_resource(id: i64, user: i64, download: bool) -> String {
    format!("video:{id}:{user}:{}", if download { "download" } else { "watch" })
}

pub fn media_link(app: &AppState, origin: &str, id: i64, user: i64, name: &str, download: bool) -> String {
    let expires = now_ms() / 1000 + LINK_LIFETIME_SECS;
    let signature = app.keys.sign_media(&media_resource(id, user, download), expires);
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
    format!("{origin}/media/{id}/{user}/{expires}/{signature}/{encoded}{}", if download { "?dl=1" } else { "" })
}

pub async fn detail(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> AppResult<Json<StreamDetail>> {
    user.require("streams.view")?;
    let origin = crate::web::media_origin(&app, &headers);
    set_global_retention(app.settings.get().await.retention_days);
    let (summary, login, name, avatar, audio_codec, gaps, error, chapters, parts, dir) = app
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
                statement.query_map([&dir], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
            Ok((summary, login, name, avatar, audio_codec, gaps, error, chapters, parts, dir))
        })
        .await?;
    let located = Located {
        dir: storage::stream_dir(&app.config.streams_dir(), &dir).ok_or_else(AppError::not_found)?,
        part: summary.part,
        status: summary.status.clone(),
        started_at: summary.started_at,
        duration_ms: summary.duration_ms,
        login: login.clone(),
        title: summary.title.clone(),
    };
    let file = download_name(&located, "mp4");
    let timeline_path = located.dir.join(storage::timeline_file(located.part));
    let cuts = tokio::task::spawn_blocking(move || Timeline::load(&timeline_path).cuts()).await.unwrap_or_default();
    Ok(Json(StreamDetail {
        video_url: media_link(&app, &origin, id, user.id, &file, false),
        download_url: user.can("streams.download").then(|| media_link(&app, &origin, id, user.id, &file, true)),
        summary,
        streamer_login: login,
        streamer_name: name,
        streamer_avatar: avatar,
        audio_codec,
        gaps,
        error,
        chapters,
        parts,
        cuts,
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
    crate::audit::record(&app, &user, if body.keep_forever { "stream.keep" } else { "stream.unkeep" }, id.to_string())
        .await;
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
    crate::audit::record(&app, &user, "stream.delete", format!("{id} {} {}", located.login, located.title)).await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn thumbnail(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<Response> {
    user.require("streams.view")?;
    let located = locate(&app, id).await?;
    let bytes = tokio::fs::read(located.dir.join(storage::THUMBNAIL_FILE)).await?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=300")], bytes).into_response())
}

/// Where one chat line sits in `chat.ndjson`, and its time in the video. The lines themselves
/// stay on disk: a busy recording's index takes a few megabytes where the parsed lines took
/// hundreds.
#[derive(Debug, Clone, Copy)]
struct Entry {
    /// Video time, milliseconds.
    o: i64,
    offset: u64,
    len: u32,
}

/// Chat indexes kept in memory, by recording and file size, with when each was last used.
type ChatCache = Mutex<HashMap<(i64, u64), (Arc<Vec<Entry>>, std::time::Instant)>>;

/// Lines indexed across all cached chats: under a hundred megabytes, whatever their number.
const CACHED_LINES: usize = 4_000_000;

fn cache() -> &'static ChatCache {
    static CACHE: OnceLock<ChatCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What indexing needs from a line: its time, and that it is a whole chat line.
#[derive(Deserialize)]
struct Stamp {
    t: i64,
    #[allow(dead_code)]
    k: serde::de::IgnoredAny,
}

/// Indexes a chat file line by line, in video order.
fn index_chat(path: &std::path::Path, timeline: &Timeline, keep: impl Fn(i64) -> bool) -> Vec<Entry> {
    use std::io::BufRead as _;
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    let mut reader = std::io::BufReader::with_capacity(256 * 1024, file);
    let mut entries = Vec::new();
    let mut line = Vec::with_capacity(1024);
    let mut offset = 0u64;
    loop {
        line.clear();
        let Ok(read) = reader.read_until(b'\n', &mut line) else { break };
        if read == 0 {
            break;
        }
        let here = offset;
        offset += read as u64;
        let text = line.trim_ascii_end();
        let Ok(len) = u32::try_from(text.len()) else { continue };
        let Ok(stamp) = serde_json::from_slice::<Stamp>(text) else { continue };
        if let Some(o) = timeline.video_time(stamp.t).filter(|&o| keep(o)) {
            entries.push(Entry { o, offset: here, len });
        }
    }
    entries.sort_by_key(|entry| entry.o);
    entries.shrink_to_fit();
    entries
}

/// Reads the lines of `entries` from the chat file, in order, handing each with its video time.
/// Lines mostly follow each other on disk, so they are read in large blocks.
fn read_lines(path: &std::path::Path, entries: &[Entry], mut each: impl FnMut(i64, &[u8]) -> bool) {
    use std::os::unix::fs::FileExt as _;
    let Ok(file) = std::fs::File::open(path) else { return };
    let mut block = Vec::new();
    let mut block_at = 0u64;
    for entry in entries {
        let len = entry.len as usize;
        let inside = entry.offset >= block_at && entry.offset + len as u64 <= block_at + block.len() as u64;
        if !inside {
            block.resize(len.max(256 * 1024), 0);
            let Ok(read) = file.read_at(&mut block, entry.offset) else { return };
            block.truncate(read);
            block_at = entry.offset;
            if read < len {
                continue;
            }
        }
        let start = (entry.offset - block_at) as usize;
        if !each(entry.o, &block[start..start + len]) {
            return;
        }
    }
}

/// A stored line as the player wants it: its video time first, then the line as recorded.
fn push_timed(out: &mut Vec<u8>, o: i64, line: &[u8]) {
    out.extend_from_slice(b"{\"o\":");
    out.extend_from_slice(o.to_string().as_bytes());
    out.push(b',');
    out.extend_from_slice(&line[1..]);
}

/// The recording's chat index in video time, cached while the file doesn't change.
async fn timed_chat(id: i64, located: &Located) -> AppResult<Arc<Vec<Entry>>> {
    let chat_path = located.dir.join(storage::CHAT_FILE);
    let size = match tokio::fs::metadata(&chat_path).await {
        Ok(meta) => meta.len(),
        Err(_) => return Ok(Arc::new(Vec::new())),
    };
    if let Some(found) = cache().lock().ok().and_then(|mut cache| {
        cache.get_mut(&(id, size)).map(|(lines, used)| {
            *used = std::time::Instant::now();
            Arc::clone(lines)
        })
    }) {
        return Ok(found);
    }
    let timeline_path = located.dir.join(storage::timeline_file(located.part));
    let limit = located.duration_ms + 5_000;
    let recording = located.status == "recording";
    let lines = tokio::task::spawn_blocking(move || -> Vec<Entry> {
        let timeline = Timeline::load(&timeline_path);
        index_chat(&chat_path, &timeline, |o| recording || o <= limit)
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?;
    let lines = Arc::new(lines);
    if let Ok(mut cache) = cache().lock() {
        cache.retain(|(cached, _), _| *cached != id);
        // The least recently used go first, until the new one fits.
        let mut total: usize = cache.values().map(|(lines, _)| lines.len()).sum();
        while total + lines.len() > CACHED_LINES {
            let Some(oldest) = cache.iter().min_by_key(|(_, (_, used))| *used).map(|(key, _)| *key) else { break };
            total -= cache.remove(&oldest).map_or(0, |(lines, _)| lines.len());
        }
        cache.insert((id, size), (Arc::clone(&lines), std::time::Instant::now()));
    }
    Ok(lines)
}

/// A response body written by a blocking thread as it goes, so that a download of millions of
/// lines never sits whole in memory. The thread stops when the client goes away.
fn streamed(write: impl FnOnce(&mut dyn FnMut(Vec<u8>) -> bool) + Send + 'static) -> axum::body::Body {
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
    tokio::task::spawn_blocking(move || {
        let mut send = |chunk: Vec<u8>| sender.blocking_send(chunk).is_ok();
        write(&mut send);
    });
    // Polling again after the end is allowed here (compression does it), unlike with `unfold`.
    axum::body::Body::from_stream(futures_util::stream::poll_fn(move |cx| {
        receiver.poll_recv(cx).map(|chunk| chunk.map(|chunk| Ok::<_, std::io::Error>(bytes::Bytes::from(chunk))))
    }))
}

/// Chunks of a streamed body are sent once they reach this size.
const CHUNK: usize = 256 * 1024;

#[derive(Deserialize)]
pub struct Window {
    /// Video milliseconds, inclusive.
    from: Option<i64>,
    /// Video milliseconds, exclusive.
    to: Option<i64>,
    /// Asks for the lines said before this time (exclusive) instead: the last `limit` of them.
    before: Option<i64>,
    limit: Option<usize>,
}

/// Chat between two video times, or the last lines before one: the player asks a few minutes
/// ahead as the video plays, and a hundred lines back after a jump or when the reader scrolls up.
pub async fn chat_window(
    State(app): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    Query(window): Query<Window>,
) -> AppResult<Response> {
    user.require("streams.view")?;
    let located = locate(&app, id).await?;
    let lines = timed_chat(id, &located).await?;
    let range = if let Some(before) = window.before {
        let end = lines.partition_point(|line| line.o < before);
        end.saturating_sub(window.limit.unwrap_or(100).min(1000))..end
    } else {
        let from = window.from.unwrap_or(0);
        let to = window.to.unwrap_or(from + 5 * 60_000).min(from + 30 * 60_000);
        let start = lines.partition_point(|line| line.o < from);
        let end = lines.partition_point(|line| line.o < to);
        start..end.max(start)
    };
    let chat_path = located.dir.join(storage::CHAT_FILE);
    let body = tokio::task::spawn_blocking(move || {
        let slice = &lines[range];
        let mut out = Vec::with_capacity(slice.iter().map(|entry| entry.len as usize + 16).sum::<usize>() + 2);
        out.push(b'[');
        read_lines(&chat_path, slice, |o, line| {
            if out.len() > 1 {
                out.push(b',');
            }
            push_timed(&mut out, o, line);
            true
        });
        out.push(b']');
        out
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?;
    let cache = if located.status == "recording" { "no-store" } else { "private, max-age=3600" };
    Ok(([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, cache)], body).into_response())
}

fn attachment(name: &str) -> String {
    let ascii: String = name.chars().map(|c| if c.is_ascii_graphic() && c != '"' { c } else { '_' }).collect();
    format!("attachment; filename=\"{ascii}\"")
}

pub async fn chat_json(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<Response> {
    user.require("streams.download")?;
    let located = locate(&app, id).await?;
    let lines = timed_chat(id, &located).await?;
    let mut head = serde_json::to_vec(&serde_json::json!({
        "channel": located.login,
        "title": located.title,
        "started_at": located.started_at,
    }))?;
    head.pop();
    head.extend_from_slice(b",\"messages\":[");
    let chat_path = located.dir.join(storage::CHAT_FILE);
    let body = streamed(move |send| {
        let mut out = head;
        let mut first = true;
        let mut open = true;
        read_lines(&chat_path, &lines, |o, line| {
            if !std::mem::take(&mut first) {
                out.push(b',');
            }
            push_timed(&mut out, o, line);
            if out.len() >= CHUNK {
                open = send(std::mem::replace(&mut out, Vec::with_capacity(CHUNK + 4096)));
            }
            open
        });
        if open {
            out.extend_from_slice(b"]}");
            send(out);
        }
    });
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
    (hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("&H{}{}{}&", &hex[4..6], &hex[2..4], &hex[0..2]))
}

/// The chat as subtitles, for players such as VLC or mpv: each message shows for a few
/// seconds at the bottom left, the newest under the others.
pub async fn chat_ass(State(app): State<AppState>, user: CurrentUser, Path(id): Path<i64>) -> AppResult<Response> {
    user.require("streams.download")?;
    let located = locate(&app, id).await?;
    let lines = timed_chat(id, &located).await?;
    let chat_path = located.dir.join(storage::CHAT_FILE);
    let body = streamed(move |send| write_ass(&chat_path, &lines, send));
    let name = download_name(&located, "chat.ass");
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/x-ssa; charset=utf-8".to_owned()),
            (header::CONTENT_DISPOSITION, attachment(&name)),
        ],
        body,
    )
        .into_response())
}

fn write_ass(chat_path: &std::path::Path, lines: &[Entry], send: &mut dyn FnMut(Vec<u8>) -> bool) {
    let mut out = String::with_capacity(CHUNK + 4096);
    out.push_str(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, \
         Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, \
         MarginR, MarginV, Encoding\n\
         Style: Chat,Inter,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,1,40,1100,40,1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
    );
    let mut open = true;
    read_lines(chat_path, lines, |o, raw| {
        let Ok(line) = serde_json::from_slice::<ChatLine>(raw) else { return true };
        if !matches!(line.k.as_str(), "m" | "a" | "n") {
            return true;
        }
        let name = if line.n.is_empty() { &line.u } else { &line.n };
        let text = if line.k == "n" && line.m.is_empty() { &line.s } else { &line.m };
        let clean = |s: &str| s.replace(['{', '}'], "").replace('\n', " ");
        let color = ass_color(&line.c).map(|c| format!("{{\\c{c}}}")).unwrap_or_default();
        let _ = writeln!(
            out,
            "Dialogue: 0,{},{},Chat,,0,0,0,,{color}{{\\b1}}{}{{\\b0\\c&HFFFFFF&}}: {}",
            ass_time(o),
            ass_time(o + 8_000),
            clean(name),
            clean(text)
        );
        if out.len() >= CHUNK {
            open = send(std::mem::replace(&mut out, String::with_capacity(CHUNK + 4096)).into_bytes());
        }
        open
    });
    if open {
        send(out.into_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_subtitle_times_and_colours() {
        assert_eq!(ass_time(3_723_450), "1:02:03.45");
        assert_eq!(ass_color("#FF4500").as_deref(), Some("&H0045FF&"));
        // Not a colour, and not a panic either.
        assert_eq!(ass_color("#aéé0"), None);
    }

    #[test]
    fn indexed_chat_reads_back_lines_in_video_order() {
        let dir = std::env::temp_dir().join(format!("vixion-chat-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chat.ndjson");
        // Out of order, a torn last line, CRLF, and one line before the recording started.
        let text = "{\"t\":1300,\"k\":\"m\",\"u\":\"b\",\"m\":\"second\"}\r\n\
                    {\"t\":500,\"k\":\"m\",\"m\":\"too early\"}\n\
                    {\"t\":1100,\"k\":\"m\",\"u\":\"a\",\"m\":\"first é\"}\n\
                    {\"t\":1200,\"k\":";
        std::fs::write(&path, text).unwrap();
        let timeline = Timeline { anchors: vec![(0, 1000)], cuts: vec![] };
        let entries = index_chat(&path, &timeline, |_| true);
        let mut out = Vec::new();
        read_lines(&path, &entries, |o, line| {
            push_timed(&mut out, o, line);
            out.push(b'\n');
            true
        });
        std::fs::remove_dir_all(&dir).unwrap();
        let lines: Vec<serde_json::Value> =
            String::from_utf8(out).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["o"], 100);
        assert_eq!(lines[0]["m"], "first é");
        assert_eq!(lines[1]["o"], 300);
        assert_eq!(lines[1]["u"], "b");
    }
}
