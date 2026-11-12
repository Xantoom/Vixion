//! The state every part of the server shares.

use std::sync::Arc;

use crate::alerts::Alerts;
use crate::auth::LoginLimiter;
use crate::config::Config;
use crate::crypto::Keys;
use crate::db::Db;
use crate::logs::LogBuffer;
use crate::recorder::Recorder;
use crate::settings::SettingsStore;
use crate::twitch::api::TwitchApi;

pub struct App {
    pub config: Config,
    pub db: Db,
    pub keys: Keys,
    pub settings: SettingsStore,
    pub alerts: Alerts,
    pub logs: LogBuffer,
    pub twitch: TwitchApi,
    /// For everything outside Twitch: webhooks, Cloudflare.
    pub http: reqwest::Client,
    pub recorder: Recorder,
    pub limiter: LoginLimiter,
    pub started_at: i64,
}

pub type AppState = Arc<App>;
