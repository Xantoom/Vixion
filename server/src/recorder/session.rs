//! One broadcast being recorded: playlist, segments, chat, parts.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use super::LiveProgress;
use super::storage::{self, Timeline};
use crate::alerts::Level;
use crate::app::AppState;
use crate::db::now_ms;
use crate::media::fmp4::Writer;
use crate::media::mp4read::{self, Init};
use crate::media::{Segment, ts};
use crate::twitch::api::TwitchError;
use crate::twitch::chat;
use crate::twitch::hls::{self, Variant};

pub struct Broadcast {
    pub streamer_id: i64,
    pub login: String,
    pub display_name: String,
    pub twitch_stream_id: String,
    pub title: String,
    pub game: Option<String>,
    pub preview_url: Option<String>,
}

/// How long a broadcast may stay unplayable before giving up.
const START_PATIENCE: Duration = Duration::from_secs(180);
/// Without a new segment for this long, Twitch is asked whether the broadcast is still live.
const STALE: Duration = Duration::from_secs(40);
const SEGMENT_TIMEOUT: Duration = Duration::from_secs(20);
/// Progress is written to the database this often.
const SAVE_EVERY: Duration = Duration::from_secs(10);

struct Source {
    playlist: String,
    variant: Variant,
    /// The player type the token was asked for: each gets its own ads.
    player: &'static str,
}

/// Player types tried, in order, to get around an ad: the first without one wins.
const AD_FREE_PLAYERS: [&str; 4] = ["popout", "embed", "frontpage", "site"];
/// Ads are dodged at most this often: each try costs a few requests.
const DODGE_EVERY: Duration = Duration::from_secs(20);

/// A part: one video file in the broadcast's folder.
struct Part {
    row: i64,
    number: i64,
    writer: Writer,
    timeline: Timeline,
    saved: Instant,
}

struct Session<'a> {
    app: &'a AppState,
    broadcast: &'a Broadcast,
    folder: String,
    path: PathBuf,
    part: Option<Part>,
    parts_done: Vec<i64>,
    /// Parts recorded before this session, when it resumes a broadcast (after a restart).
    earlier_parts: i64,
    progress: Arc<Mutex<LiveProgress>>,
    chat_count: Arc<AtomicU64>,
    ads_ms: i64,
}

async fn sleep_or_stop(stop: &mut watch::Receiver<bool>, duration: Duration) {
    tokio::select! {
        () = tokio::time::sleep(duration) => {}
        _ = stop.changed() => {}
    }
}

/// Finds the best playlist. Without a token, the `popout` player gets no pre-roll ad and the
/// source quality; the `site` player is asked too when it may offer HEVC or AV1.
async fn pick_source(
    app: &AppState,
    login: &str,
    token: Option<&str>,
    h264_only: bool,
) -> Result<Option<Source>, TwitchError> {
    let mut player = if token.is_some() { "site" } else { "popout" };
    let mut variants = app.twitch.variants(login, player, token, h264_only).await?;
    let best = hls::best_variant(&variants, h264_only).cloned();
    if token.is_none()
        && !h264_only
        && best.as_ref().is_some_and(|variant| variant.video_codec() == "h264")
        && let Ok(site) = app.twitch.variants(login, "site", None, h264_only).await
        && let Some(better) = hls::best_variant(&site, h264_only)
        && best.as_ref().is_some_and(|best| better.height > best.height || better.video_codec() != "h264")
    {
        variants = site;
        player = "site";
    }
    Ok(hls::best_variant(&variants, h264_only).cloned().map(|variant| Source {
        playlist: variant.uri.clone(),
        variant,
        player,
    }))
}

/// Looks for the same picture from another player type that isn't showing an ad right now.
async fn dodge_ad(app: &AppState, login: &str, current: &Source) -> Option<Source> {
    let token = app.settings.twitch_token().await;
    let h264_only = app.settings.get().await.h264_only;
    for player in AD_FREE_PLAYERS.into_iter().filter(|player| *player != current.player) {
        let Ok(variants) = app.twitch.variants(login, player, token.as_deref(), h264_only).await else { continue };
        let Some(variant) = hls::best_variant(&variants, h264_only) else { continue };
        if variant.height < current.variant.height || variant.video_codec() != current.variant.video_codec() {
            continue;
        }
        let Ok(text) = app.twitch.get_text(&variant.uri).await else { continue };
        if hls::parse_media(&text).segments.last().is_some_and(|segment| !segment.ad) {
            tracing::info!(%login, player, "ad avoided with another player");
            return Some(Source { playlist: variant.uri.clone(), variant: variant.clone(), player });
        }
    }
    None
}

/// Picks a source, waiting while the broadcast isn't playable yet.
async fn wait_for_source(app: &AppState, login: &str, stop: &mut watch::Receiver<bool>) -> Option<Source> {
    let started = Instant::now();
    let mut token = app.settings.twitch_token().await;
    while !*stop.borrow() && started.elapsed() < START_PATIENCE {
        let h264_only = app.settings.get().await.h264_only;
        match pick_source(app, login, token.as_deref(), h264_only).await {
            Ok(Some(source)) => {
                app.alerts.resolve("twitch_integrity").await;
                return Some(source);
            }
            Ok(None) => {}
            Err(TwitchError::BadToken) if token.is_some() => {
                app.alerts
                    .raise(
                        Level::Warning,
                        "twitch_token",
                        "The Twitch token was refused: recording without it, ads included. Update it in the settings.",
                    )
                    .await;
                token = None;
                continue;
            }
            Err(TwitchError::Integrity) => {
                app.alerts
                    .raise(
                        Level::Error,
                        "twitch_integrity",
                        "Twitch asks for a browser integrity check: recordings can't start",
                    )
                    .await;
            }
            Err(error) => tracing::warn!(%login, %error, "no playlist yet"),
        }
        sleep_or_stop(stop, Duration::from_secs(10)).await;
    }
    None
}

pub async fn run(
    app: &AppState,
    broadcast: Broadcast,
    mut stop: watch::Receiver<bool>,
    progress: Arc<Mutex<LiveProgress>>,
    chat_count: Arc<AtomicU64>,
) {
    let login = broadcast.login.clone();
    let Some(mut source) = wait_for_source(app, &login, &mut stop).await else {
        tracing::warn!(%login, "the broadcast never became playable");
        return;
    };
    tracing::info!(
        %login,
        quality = %source.variant.name,
        codec = source.variant.video_codec(),
        "recording source picked"
    );

    // A broadcast already partly recorded (the server restarted meanwhile) goes on in its folder.
    let (streamer_id, twitch_id) = (broadcast.streamer_id, broadcast.twitch_stream_id.clone());
    let earlier: Option<(String, i64)> = app
        .db
        .read(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT dir, MAX(part) FROM streams WHERE streamer_id = ?1 AND twitch_stream_id = ?2 GROUP BY dir
                     ORDER BY MAX(started_at) DESC LIMIT 1",
                    rusqlite::params![streamer_id, twitch_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .ok())
        })
        .await
        .ok()
        .flatten()
        .filter(|(dir, _)| storage::stream_dir(&app.config.streams_dir(), dir).is_some_and(|path| path.is_dir()));
    let earlier_parts = earlier.as_ref().map_or(0, |(_, parts)| *parts);
    let folder = earlier.map_or_else(
        || format!("{}/{}_{}", login.to_ascii_lowercase(), storage::folder_stamp(now_ms()), broadcast.twitch_stream_id),
        |(dir, _)| dir,
    );
    if earlier_parts > 0 {
        tracing::info!(%login, folder, "resuming the broadcast's recording");
    }
    let Some(path) = storage::stream_dir(&app.config.streams_dir(), &folder) else { return };
    if let Err(error) = tokio::fs::create_dir_all(&path).await {
        app.alerts.raise(Level::Error, "storage", format!("Can't create {}: {error}", path.display())).await;
        return;
    }

    let (chat_stop, chat_stop_rx) = watch::channel(false);
    let chat_task = app.settings.get().await.record_chat.then(|| {
        tokio::spawn(chat::record(login.clone(), path.join(storage::CHAT_FILE), chat_stop_rx, Arc::clone(&chat_count)))
    });
    let thumbnail_task = broadcast.preview_url.clone().map(|url| {
        let (app, path) = (app.clone(), path.clone());
        tokio::spawn(thumbnails(app, url, path, Arc::clone(&progress)))
    });

    let mut session = Session {
        app,
        broadcast: &broadcast,
        folder,
        path,
        part: None,
        parts_done: Vec::new(),
        earlier_parts,
        progress,
        chat_count,
        ads_ms: 0,
    };
    session.follow(&mut source, &mut stop).await;
    session.finish_part(None).await;

    let _ = chat_stop.send(true);
    if let Some(task) = chat_task {
        let _ = task.await;
    }
    if let Some(task) = thumbnail_task {
        task.abort();
    }
    // A broadcast that never produced a picture leaves nothing behind.
    if session.parts_done.is_empty() && session.earlier_parts == 0 {
        let _ = tokio::fs::remove_dir_all(&session.path).await;
    }
    tracing::info!(%login, parts = session.parts_done.len(), "recording ended");
}

impl Session<'_> {
    /// Follows the playlist until the broadcast ends or the session is stopped.
    async fn follow(&mut self, source: &mut Source, stop: &mut watch::Receiver<bool>) {
        let login = self.broadcast.login.clone();
        let mut last_date: Option<i64> = None;
        let mut last_sequence: Option<u64> = None;
        let mut discontinuity = false;
        let mut fresh = Instant::now();
        let mut failures = 0u32;
        let mut init: Option<(String, Init)> = None;
        let mut previous = Segment::default();
        let mut last_dodge: Option<Instant> = None;

        while !*stop.borrow() {
            let playlist = match self.app.twitch.get_text(&source.playlist).await {
                Ok(text) => {
                    failures = 0;
                    hls::parse_media(&text)
                }
                Err(error) => {
                    failures += 1;
                    tracing::debug!(%login, %error, failures, "playlist unavailable");
                    if matches!(error, TwitchError::Status(403 | 404 | 410)) || failures.is_multiple_of(5) {
                        if !self.still_live().await {
                            break;
                        }
                        if let Some(next) = wait_for_source(self.app, &login, stop).await {
                            *source = next;
                        }
                    }
                    sleep_or_stop(stop, Duration::from_secs(2)).await;
                    continue;
                }
            };

            // An ad at the live edge: another player type may have the broadcast instead.
            if playlist.segments.last().is_some_and(|segment| segment.ad)
                && last_dodge.is_none_or(|at| at.elapsed() >= DODGE_EVERY)
            {
                last_dodge = Some(Instant::now());
                if let Some(next) = dodge_ad(self.app, &login, source).await {
                    *source = next;
                    continue;
                }
            }

            for segment in &playlist.segments {
                let new = match (segment.date, last_date) {
                    (Some(date), Some(last)) => date > last + 250,
                    _ => last_sequence.is_none_or(|last| segment.sequence > last),
                };
                if !new {
                    continue;
                }
                if let Some(last) = last_date
                    && let Some(date) = segment.date
                    && date - last > ((segment.duration + 1.5) * 1000.0) as i64
                {
                    // Segments went by unseen: the timeline is cut there.
                    discontinuity = true;
                }
                last_date = segment.date.or(last_date);
                last_sequence = Some(segment.sequence);
                fresh = Instant::now();

                if segment.ad {
                    self.ads_ms += (segment.duration * 1000.0) as i64;
                    discontinuity = true;
                    self.set_state("ad");
                    continue;
                }
                let demuxed = match self.download(segment, &mut init, &previous).await {
                    Some(demuxed) => demuxed,
                    None => {
                        discontinuity = true;
                        continue;
                    }
                };
                if demuxed.is_empty() {
                    continue;
                }
                if segment.discontinuity {
                    discontinuity = true;
                }
                if let Err(error) = self.write(&demuxed, segment.date, discontinuity).await {
                    self.app
                        .alerts
                        .raise(Level::Error, format!("write:{login}"), format!("Recording {login} failed: {error}"))
                        .await;
                    return;
                }
                discontinuity = false;
                self.set_state("recording");
                previous = demuxed;
            }

            if playlist.ended {
                break;
            }
            if fresh.elapsed() > STALE {
                if !self.still_live().await {
                    break;
                }
                // Live, but this playlist stalled: ask for a new one.
                if let Some(next) = wait_for_source(self.app, &login, stop).await {
                    *source = next;
                }
                fresh = Instant::now();
            }
            let wait = (playlist.target_duration / 2.0).clamp(1.0, 3.0);
            sleep_or_stop(stop, Duration::from_secs_f64(wait)).await;
        }
    }

    async fn still_live(&self) -> bool {
        match self.app.twitch.channel_by_login(&self.broadcast.login).await {
            Ok(Some(channel)) => channel.live().is_some_and(|stream| stream.id == self.broadcast.twitch_stream_id),
            Ok(None) => false,
            // When Twitch can't tell, keep trying rather than cut a recording short.
            Err(_) => true,
        }
    }

    fn set_state(&self, state: &'static str) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.state = state;
        }
    }

    async fn download(
        &self,
        segment: &hls::MediaSegment,
        init: &mut Option<(String, Init)>,
        previous: &Segment,
    ) -> Option<Segment> {
        let login = &self.broadcast.login;
        let mut data = None;
        for attempt in 0..3u32 {
            match self.app.twitch.get_bytes(&segment.uri, SEGMENT_TIMEOUT).await {
                Ok(bytes) => {
                    data = Some(bytes);
                    break;
                }
                Err(error) => {
                    tracing::debug!(%login, %error, attempt, "segment download failed");
                    tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt + 1))).await;
                }
            }
        }
        let Some(data) = data else {
            tracing::warn!(%login, sequence = segment.sequence, "segment lost");
            return None;
        };
        let result = match &segment.map {
            Some(map) => {
                if init.as_ref().is_none_or(|(uri, _)| uri != map) {
                    let bytes = self.app.twitch.get_bytes(map, SEGMENT_TIMEOUT).await.ok()?;
                    *init = Some((map.clone(), mp4read::parse_init(&bytes).ok()?));
                }
                let (_, parsed) = init.as_ref()?;
                mp4read::demux(&data, parsed)
            }
            None => ts::demux(&data, previous),
        };
        match result {
            Ok(segment) => Some(segment),
            Err(error) => {
                tracing::warn!(%login, %error, "unreadable segment");
                None
            }
        }
    }

    async fn write(&mut self, segment: &Segment, date: Option<i64>, discontinuity: bool) -> Result<(), String> {
        if self.part.as_ref().is_some_and(|part| !part.writer.accepts(segment)) {
            tracing::info!(login = %self.broadcast.login, "picture format changed: starting a new part");
            self.finish_part(None).await;
        }
        if self.part.is_none() {
            self.part = Some(self.start_part(segment, date).await?);
        }
        let Some(part) = self.part.as_mut() else { return Err("no part".into()) };
        let owned = segment.clone();
        let anchor =
            tokio::task::block_in_place(|| part.writer.push(owned, discontinuity)).map_err(|e| e.to_string())?;
        if let (Some(start), Some(date)) = (anchor, date) {
            part.timeline.anchors.push(((start * 1000.0).round() as i64, date));
            let path = self.path.join(storage::timeline_file(part.number));
            let _ = tokio::task::block_in_place(|| part.timeline.save(&path));
        }
        let written = part.writer.progress();
        if let Ok(mut progress) = self.progress.lock() {
            progress.stream_id = part.row;
            progress.duration_ms = written.duration_ms;
            progress.bytes = written.bytes;
            progress.ads_skipped_ms = self.ads_ms;
            progress.chat_messages = self.chat_count.load(Ordering::Relaxed);
            progress.fps = written.fps;
        }
        if part.saved.elapsed() >= SAVE_EVERY {
            part.saved = Instant::now();
            let (row, ads, chat, gaps) =
                (part.row, self.ads_ms, self.chat_count.load(Ordering::Relaxed), part.writer.discontinuities);
            let _ = self
                .app
                .db
                .write(move |conn| {
                    conn.execute(
                        "UPDATE streams SET duration_ms = ?2, size_bytes = ?3, ads_skipped_ms = ?4, chat_messages = ?5,
                         gaps = ?6, fps = ?7 WHERE id = ?1",
                        rusqlite::params![
                            row,
                            written.duration_ms,
                            i64::try_from(written.bytes).unwrap_or(i64::MAX),
                            ads,
                            i64::try_from(chat).unwrap_or(0),
                            gaps,
                            written.fps
                        ],
                    )?;
                    Ok(())
                })
                .await;
        }
        Ok(())
    }

    async fn start_part(&mut self, segment: &Segment, date: Option<i64>) -> Result<Part, String> {
        let number = self.earlier_parts + i64::try_from(self.parts_done.len()).unwrap_or(0) + 1;
        let video = segment.video.as_ref().map(|track| &track.config);
        let audio = segment.audio.as_ref().map(|track| &track.config);
        let file = self.path.join(storage::video_file(number));
        let writer = tokio::task::block_in_place(|| Writer::create(&file, video, audio)).map_err(|e| e.to_string())?;
        let values = (
            self.broadcast.streamer_id,
            self.broadcast.twitch_stream_id.clone(),
            number,
            self.broadcast.title.clone(),
            self.broadcast.game.clone(),
            date,
            self.folder.clone(),
            video.map(|config| config.codec),
            audio.map(|config| config.codec),
            video.map(|config| config.width),
            video.map(|config| config.height),
        );
        let has_thumbnail = self.path.join(storage::THUMBNAIL_FILE).exists();
        let row = self
            .app
            .db
            .write(move |conn| {
                let now = now_ms();
                conn.execute(
                    "INSERT INTO streams (streamer_id, twitch_stream_id, part, title, game, status, started_at,
                     video_start_at, dir, video_codec, audio_codec, width, height, has_thumbnail)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'recording', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                    rusqlite::params![
                        values.0,
                        values.1,
                        values.2,
                        values.3,
                        values.4,
                        now,
                        values.5.unwrap_or(now),
                        values.6,
                        values.7,
                        values.8,
                        values.9,
                        values.10,
                        has_thumbnail
                    ],
                )?;
                let row = conn.last_insert_rowid();
                conn.execute(
                    "INSERT OR IGNORE INTO stream_chapters (stream_id, at_ms, title, game) VALUES (?1, 0, ?2, ?3)",
                    rusqlite::params![row, values.3, values.4],
                )?;
                Ok(row)
            })
            .await
            .map_err(|e| e.to_string())?;
        if let Ok(mut progress) = self.progress.lock() {
            progress.stream_id = row;
            progress.codec = video.map(|config| config.codec).unwrap_or("audio").to_owned();
            progress.width = video.map_or(0, |config| config.width);
            progress.height = video.map_or(0, |config| config.height);
        }
        tracing::info!(login = %self.broadcast.login, display = %self.broadcast.display_name, part = number, "recording started");
        Ok(Part { row, number, writer, timeline: Timeline::default(), saved: Instant::now() })
    }

    /// Closes the current part: index, duration, database row.
    async fn finish_part(&mut self, error: Option<String>) {
        let Some(part) = self.part.take() else { return };
        let path = self.path.join(storage::timeline_file(part.number));
        let _ = tokio::task::block_in_place(|| part.timeline.save(&path));
        let gaps = part.writer.discontinuities;
        let finished = tokio::task::block_in_place(|| part.writer.finish());
        let (status, written, error) = match finished {
            Ok(written) => (if error.is_some() { "failed" } else { "done" }, written, error),
            Err(failure) => ("failed", crate::media::fmp4::Progress::default(), Some(failure.to_string())),
        };
        let (row, ads, chat) = (part.row, self.ads_ms, self.chat_count.load(Ordering::Relaxed));
        let result = self
            .app
            .db
            .write(move |conn| {
                conn.execute(
                    "UPDATE streams SET status = ?2, ended_at = ?3, duration_ms = ?4, size_bytes = ?5,
                     ads_skipped_ms = ?6, chat_messages = ?7, gaps = ?8, fps = ?9, error = ?10 WHERE id = ?1",
                    rusqlite::params![
                        row,
                        status,
                        now_ms(),
                        written.duration_ms,
                        i64::try_from(written.bytes).unwrap_or(i64::MAX),
                        ads,
                        i64::try_from(chat).unwrap_or(0),
                        gaps,
                        written.fps,
                        error
                    ],
                )?;
                Ok(())
            })
            .await;
        if let Err(failure) = result {
            tracing::error!(%failure, "can't save the end of a recording");
        }
        self.parts_done.push(row);
    }
}

/// Saves Twitch's preview picture as the recording's thumbnail: early, then once the broadcast
/// is past its intro screen.
async fn thumbnails(app: AppState, url: String, folder: PathBuf, progress: Arc<Mutex<LiveProgress>>) {
    for wait in [20u64, 240] {
        tokio::time::sleep(Duration::from_secs(wait)).await;
        let fresh = format!("{url}{}t={}", if url.contains('?') { '&' } else { '?' }, now_ms());
        let Ok(bytes) = app.twitch.get_bytes(&fresh, Duration::from_secs(15)).await else { continue };
        if bytes.len() < 1024 || tokio::fs::write(folder.join(storage::THUMBNAIL_FILE), &bytes).await.is_err() {
            continue;
        }
        let row = progress.lock().map(|progress| progress.stream_id).unwrap_or(0);
        if row != 0 {
            let _ = app
                .db
                .write(move |conn| {
                    let dir: String = conn.query_row("SELECT dir FROM streams WHERE id = ?1", [row], |r| r.get(0))?;
                    conn.execute("UPDATE streams SET has_thumbnail = 1 WHERE dir = ?1", [dir])?;
                    Ok(())
                })
                .await;
        }
    }
}
