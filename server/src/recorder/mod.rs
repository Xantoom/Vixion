//! Watches channels and records them while they are live.
//!
//! One loop asks Twitch, in a single request, which watched channels are live. Each live
//! channel gets a session task that follows its playlist until the broadcast ends.

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
use crate::twitch::api::Channel;

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

/// Runs the live checks until the process ends.
pub async fn run(app: AppState) {
    let mut failures = 0u32;
    loop {
        match check(&app).await {
            Ok(()) => {
                if failures >= 3 {
                    app.alerts.resolve("twitch_unreachable").await;
                }
                failures = 0;
            }
            Err(error) => {
                failures += 1;
                tracing::warn!(%error, failures, "live check failed");
                if failures == 3 {
                    app.alerts
                        .raise(Level::Error, "twitch_unreachable", format!("Twitch can't be reached: {error}"))
                        .await;
                }
            }
        }
        let interval = u64::from(app.settings.get().await.poll_interval);
        tokio::select! {
            () = tokio::time::sleep(Duration::from_secs(interval)) => {}
            () = app.recorder.wake.notified() => {}
        }
    }
}

async fn check(app: &AppState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let watched = app
        .db
        .read(|conn| {
            let mut statement = conn.prepare_cached("SELECT id, twitch_id, monitored FROM streamers")?;
            let rows = statement.query_map([], |row| {
                Ok(Watched { id: row.get(0)?, twitch_id: row.get(1)?, monitored: row.get::<_, i64>(2)? != 0 })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    if watched.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = watched.iter().map(|streamer| streamer.twitch_id.clone()).collect();
    let channels = app.twitch.channels_by_id(&ids).await?;

    for channel in channels {
        let Some(streamer) = watched.iter().find(|streamer| streamer.twitch_id == channel.id) else { continue };
        update_streamer(app, streamer.id, &channel).await;
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
                start(app, streamer.id, &channel, stream.id.clone());
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
    Ok(())
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
    );
    let result = app
        .db
        .write(move |conn| {
            conn.execute(
                "UPDATE streamers SET login = ?2, display_name = ?3, avatar_url = ?4, live_title = ?5, live_game = ?6,
                 live_since = ?7 WHERE id = ?1",
                rusqlite::params![streamer_id, values.0, values.1, values.2, values.3, values.4, values.5],
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
