//! Watches channels and records them while they are live.
//!
//! One loop asks Twitch which watched channels are live, a hundred per request, at a pace that
//! follows the number of channels and backs off when Twitch refuses. Each live channel gets a
//! session task that follows its playlist until the broadcast ends.

pub mod retention;
mod session;
pub mod storage;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{Notify, watch};

use crate::alerts::Level;
use crate::app::AppState;
use crate::db::now_ms;
use crate::twitch::api::{BATCH_SIZE, Channel, TwitchError};

/// What the interface shows about a recording in progress.
#[derive(Debug, Clone, Default, Serialize)]
pub struct LiveProgress {
    pub stream_id: i64,
    pub duration_ms: i64,
    pub bytes: u64,
    pub ads_skipped_ms: i64,
    pub chat_messages: u64,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// `waiting` (stream not playable yet), `recording`, `ad` (an ad is being skipped).
    pub state: &'static str,
}

struct SessionHandle {
    stop: watch::Sender<bool>,
    twitch_stream_id: String,
    title: String,
    game: Option<String>,
    progress: Arc<Mutex<LiveProgress>>,
}

pub struct Recorder {
    sessions: Mutex<HashMap<i64, SessionHandle>>,
    /// Broadcasts someone stopped by hand, by streamer: not restarted until the next broadcast.
    stopped: Mutex<HashMap<i64, String>>,
    wake: Notify,
    /// Set when the process stops: no new recording starts.
    closing: std::sync::atomic::AtomicBool,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            stopped: Mutex::new(HashMap::new()),
            wake: Notify::new(),
            closing: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Checks channels now rather than at the next interval, as after a channel was added.
    pub fn check_now(&self) {
        self.wake.notify_one();
    }

    /// Recordings in progress, by streamer ID.
    pub fn live(&self) -> HashMap<i64, LiveProgress> {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions.iter().filter_map(|(id, handle)| Some((*id, handle.progress.lock().ok()?.clone()))).collect()
            })
            .unwrap_or_default()
    }

    /// Stops a streamer's recording, keeping what was recorded.
    pub fn stop(&self, streamer_id: i64) {
        if let Ok(sessions) = self.sessions.lock()
            && let Some(handle) = sessions.get(&streamer_id)
        {
            if let Ok(mut stopped) = self.stopped.lock() {
                stopped.insert(streamer_id, handle.twitch_stream_id.clone());
            }
            let _ = handle.stop.send(true);
        }
    }

    /// Stops every recording for good: the process is ending.
    pub fn stop_all(&self) {
        self.closing.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(sessions) = self.sessions.lock() {
            for handle in sessions.values() {
                let _ = handle.stop.send(true);
            }
        }
    }

    pub fn is_recording(&self, streamer_id: i64) -> bool {
        self.sessions.lock().is_ok_and(|sessions| sessions.contains_key(&streamer_id))
    }

    fn finished(&self, streamer_id: i64) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&streamer_id);
        }
    }
}

impl Default for Recorder {
    fn default() -> Self {
        Self::new()
    }
}

struct Watched {
    id: i64,
    twitch_id: String,
    monitored: bool,
}

/// How often channels are checked: often enough to catch a broadcast within seconds of its start,
/// never more than Twitch's own web player would ask. Not a setting: the pace follows the number
/// of channels and Twitch's answers.
mod pace {
    use std::time::Duration;

    /// Between two checks of the same channel, with a few channels.
    pub const BASE: Duration = Duration::from_secs(30);
    /// Each extra batch of 100 channels adds this much to a round, so the request rate stays
    /// at about one query every ten seconds however many channels there are.
    pub const PER_BATCH: Duration = Duration::from_secs(10);
    /// Between the queries of one round.
    pub const BETWEEN_BATCHES: Duration = Duration::from_secs(2);
    /// The least time between two rounds, even when asked to check now (channels added in a
    /// row, recordings ending together).
    pub const MIN_GAP: Duration = Duration::from_secs(5);
    /// The longest wait after failures.
    pub const MAX_BACKOFF: Duration = Duration::from_secs(10 * 60);

    /// The pause after a round over `batches` queries.
    pub fn round(batches: usize) -> Duration {
        let extra = u32::try_from(batches.saturating_sub(1)).unwrap_or(u32::MAX);
        BASE.max(PER_BATCH.saturating_mul(extra))
    }

    /// The pause after `failures` failed rounds in a row: doubling from the normal pace.
    pub fn backoff(normal: Duration, failures: u32) -> Duration {
        normal.saturating_mul(1 << failures.min(6)).min(MAX_BACKOFF)
    }

    /// Up to a tenth more or less, so that many installs don't ask at the same second.
    pub fn jitter(duration: Duration) -> Duration {
        let random = u16::from_le_bytes(crate::crypto::random_bytes::<2>());
        let factor = 0.9 + 0.2 * f64::from(random) / f64::from(u16::MAX);
        duration.mul_f64(factor)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn rounds_slow_down_with_many_channels() {
            assert_eq!(round(0), BASE);
            assert_eq!(round(1), BASE);
            assert_eq!(round(3), BASE);
            assert_eq!(round(10), Duration::from_secs(90));
            assert_eq!(round(50), Duration::from_secs(490));
        }

        #[test]
        fn backoff_doubles_up_to_a_limit() {
            assert_eq!(backoff(BASE, 1), Duration::from_secs(60));
            assert_eq!(backoff(BASE, 2), Duration::from_secs(120));
            assert_eq!(backoff(BASE, 30), MAX_BACKOFF);
        }

        #[test]
        fn jitter_stays_within_a_tenth() {
            for _ in 0..200 {
                let value = jitter(BASE);
                assert!(value >= BASE.mul_f64(0.9) && value <= BASE.mul_f64(1.1));
            }
        }
    }
}

/// What a round of checks found.
enum Round {
    /// Every batch answered.
    Done { batches: usize },
    /// Some batches failed; the others were handled.
    Partial { batches: usize, error: String },
    /// Twitch asked to slow down: the round stopped there.
    Throttled { batches: usize, wait: Option<Duration> },
    /// The database couldn't be read.
    Failed(String),
}

/// Runs the live checks until the process ends.
pub async fn run(app: AppState) {
    let mut failures = 0u32;
    let mut last = tokio::time::Instant::now() - pace::MIN_GAP;
    loop {
        // Asked to check now right after a round: wait a little, once for all who asked.
        let since = last.elapsed();
        if since < pace::MIN_GAP {
            tokio::time::sleep(pace::MIN_GAP - since).await;
        }
        last = tokio::time::Instant::now();
        let wait = match check(&app).await {
            Round::Done { batches } => {
                if failures >= 3 {
                    app.alerts.resolve("twitch_unreachable").await;
                }
                failures = 0;
                pace::round(batches)
            }
            Round::Partial { batches, error } => {
                // Some channels were checked: not a failure of the whole round, but noted.
                tracing::warn!(%error, "some channels couldn't be checked");
                pace::round(batches)
            }
            Round::Throttled { batches, wait } => {
                failures += 1;
                let backoff = pace::backoff(pace::round(batches), failures);
                let wait = wait.map_or(backoff, |asked| asked.max(pace::BASE)).min(pace::MAX_BACKOFF);
                tracing::warn!(wait_secs = wait.as_secs(), "Twitch asked to slow down");
                wait
            }
            Round::Failed(error) => {
                failures += 1;
                tracing::warn!(%error, failures, "live check failed");
                if failures == 3 {
                    app.alerts
                        .raise(Level::Error, "twitch_unreachable", format!("Twitch can't be reached: {error}"))
                        .await;
                }
                pace::backoff(pace::BASE, failures)
            }
        };
        tokio::select! {
            () = tokio::time::sleep(pace::jitter(wait)) => {}
            // Asked again while backing off: the backoff wins, Twitch said no for a reason.
            () = app.recorder.wake.notified(), if failures == 0 => {}
        }
    }
}

async fn check(app: &AppState) -> Round {
    let watched = app
        .db
        .read(|conn| {
            let mut statement = conn.prepare_cached("SELECT id, twitch_id, monitored FROM streamers")?;
            let rows = statement.query_map([], |row| {
                Ok(Watched { id: row.get(0)?, twitch_id: row.get(1)?, monitored: row.get::<_, i64>(2)? != 0 })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await;
    let watched = match watched {
        Ok(watched) => watched,
        Err(error) => return Round::Failed(error.to_string()),
    };
    if watched.is_empty() {
        return Round::Done { batches: 0 };
    }
    let ids: Vec<String> = watched.iter().map(|streamer| streamer.twitch_id.clone()).collect();
    let batches = ids.len().div_ceil(BATCH_SIZE);
    let mut failed: Vec<String> = Vec::new();
    for (index, chunk) in ids.chunks(BATCH_SIZE).enumerate() {
        if index > 0 {
            tokio::time::sleep(pace::BETWEEN_BATCHES).await;
        }
        match app.twitch.channels_by_id(chunk).await {
            Ok(channels) => {
                for channel in channels {
                    if let Some(streamer) = watched.iter().find(|streamer| streamer.twitch_id == channel.id) {
                        handle(app, streamer, &channel).await;
                    }
                }
            }
            Err(TwitchError::RateLimited(wait)) => return Round::Throttled { batches, wait },
            Err(error) => failed.push(error.to_string()),
        }
    }
    match failed.len() {
        0 => Round::Done { batches },
        n if n == batches => Round::Failed(failed.swap_remove(0)),
        _ => Round::Partial { batches, error: failed.swap_remove(0) },
    }
}

/// Starts, follows or leaves alone one channel, from what Twitch said about it.
async fn handle(app: &AppState, streamer: &Watched, channel: &Channel) {
    update_streamer(app, streamer.id, channel).await;
    let live = channel.live();
    let running = app.recorder.sessions.lock().ok().and_then(|sessions| {
        sessions
            .get(&streamer.id)
            .map(|handle| (handle.twitch_stream_id.clone(), handle.title.clone(), handle.game.clone()))
    });
    let stopped_by_hand = live.is_some_and(|stream| {
        app.recorder.stopped.lock().is_ok_and(|stopped| stopped.get(&streamer.id) == Some(&stream.id))
    });
    match (live, running) {
        (Some(stream), None) if streamer.monitored && !stopped_by_hand => {
            start(app, streamer.id, channel, stream.id.clone());
        }
        (Some(stream), Some((recording, title, game))) if recording == stream.id => {
            let new_title = stream.title.clone().unwrap_or_default();
            let new_game = stream.game.as_ref().map(|game| game.name.clone());
            if new_title != title || new_game != game {
                chapter(app, streamer.id, new_title, new_game).await;
            }
        }
        _ => {}
    }
}

async fn update_streamer(app: &AppState, streamer_id: i64, channel: &Channel) {
    let live = channel.live();
    let values = (
        channel.login.clone(),
        channel.display_name.clone(),
        channel.profile_image_url.clone(),
        live.and_then(|stream| stream.title.clone()),
        live.and_then(|stream| stream.game.as_ref().map(|game| game.name.clone())),
        live.map(|stream| {
            stream.created_at.as_deref().and_then(crate::twitch::hls::parse_iso8601).unwrap_or_else(now_ms)
        }),
        channel.banner_image_url.clone(),
        live.and_then(|stream| stream.viewers_count),
    );
    let result = app
        .db
        .write(move |conn| {
            conn.execute(
                "UPDATE streamers SET login = ?2, display_name = ?3, avatar_url = ?4, live_title = ?5, live_game = ?6,
                 live_since = ?7, banner_url = ?8, live_viewers = ?9 WHERE id = ?1",
                rusqlite::params![
                    streamer_id,
                    values.0,
                    values.1,
                    values.2,
                    values.3,
                    values.4,
                    values.5,
                    values.6,
                    values.7
                ],
            )?;
            Ok(())
        })
        .await;
    if let Err(error) = result {
        tracing::warn!(%error, "can't update a streamer");
    }
}

async fn chapter(app: &AppState, streamer_id: i64, title: String, game: Option<String>) {
    let progress = {
        let Ok(mut sessions) = app.recorder.sessions.lock() else { return };
        let Some(handle) = sessions.get_mut(&streamer_id) else { return };
        handle.title.clone_from(&title);
        handle.game.clone_from(&game);
        handle.progress.lock().map(|p| p.clone()).unwrap_or_default()
    };
    if progress.stream_id == 0 {
        return;
    }
    let _ = app
        .db
        .write(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO stream_chapters (stream_id, at_ms, title, game) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![progress.stream_id, progress.duration_ms, title, game],
            )?;
            conn.execute(
                "UPDATE streams SET title = ?2, game = COALESCE(game, ?3) WHERE id = ?1",
                rusqlite::params![progress.stream_id, title, game],
            )?;
            Ok(())
        })
        .await;
}

fn start(app: &AppState, streamer_id: i64, channel: &Channel, twitch_stream_id: String) {
    let Some(stream) = channel.live() else { return };
    if app.recorder.closing.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let (stop, stop_rx) = watch::channel(false);
    let progress = Arc::new(Mutex::new(LiveProgress { state: "waiting", ..LiveProgress::default() }));
    let handle = SessionHandle {
        stop,
        twitch_stream_id: twitch_stream_id.clone(),
        title: stream.title.clone().unwrap_or_default(),
        game: stream.game.as_ref().map(|game| game.name.clone()),
        progress: Arc::clone(&progress),
    };
    if let Ok(mut sessions) = app.recorder.sessions.lock() {
        if sessions.contains_key(&streamer_id) {
            return;
        }
        sessions.insert(streamer_id, handle);
    }
    let info = session::Broadcast {
        streamer_id,
        login: channel.login.clone(),
        display_name: channel.display_name.clone(),
        twitch_stream_id,
        title: stream.title.clone().unwrap_or_default(),
        game: stream.game.as_ref().map(|game| game.name.clone()),
        preview_url: stream.preview_image_url.clone(),
    };
    tracing::info!(channel = %info.login, "live, recording");
    let app = app.clone();
    tokio::spawn(async move {
        if retention::room_to_record(&app).await {
            app.alerts.resolve("disk_full").await;
            let chat_count = Arc::new(AtomicU64::new(0));
            session::run(&app, info, stop_rx, progress, chat_count).await;
            app.recorder.finished(streamer_id);
            // Still live after an early end (a network failure): pick it up again right away.
            app.recorder.check_now();
        } else {
            app.alerts
                .raise(Level::Error, "disk_full", format!("No room left on disk: {} is not recorded", info.login))
                .await;
            app.recorder.finished(streamer_id);
        }
    });
}
