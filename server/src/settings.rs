//! Settings an administrator changes while the app runs, stored in the database.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::crypto::Keys;
use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WebhookKind {
    #[default]
    Discord,
    Ntfy,
    Generic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Days a recording is kept unless marked to keep forever. 0 keeps everything.
    pub retention_days: u32,
    /// Records H.264 only, even when the broadcaster sends HEVC or AV1.
    pub h264_only: bool,
    /// Seconds between live checks.
    pub poll_interval: u32,
    pub record_chat: bool,
    /// Free space under which an alert is raised, in gigabytes.
    pub disk_warning_gb: u32,
    /// Free space under which new recordings don't start and the oldest unprotected are removed.
    pub disk_reserve_gb: u32,
    pub webhook_url: String,
    pub webhook_kind: WebhookKind,
    /// Whether a Twitch token is stored; the token itself never leaves the server.
    #[serde(skip_deserializing)]
    pub has_twitch_token: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            retention_days: 14,
            h264_only: false,
            poll_interval: 30,
            record_chat: true,
            disk_warning_gb: 20,
            disk_reserve_gb: 5,
            webhook_url: String::new(),
            webhook_kind: WebhookKind::Discord,
            has_twitch_token: false,
        }
    }
}

impl Settings {
    fn validate(&mut self) -> AppResult<()> {
        self.poll_interval = self.poll_interval.clamp(15, 600);
        self.retention_days = self.retention_days.min(3650);
        self.webhook_url = self.webhook_url.trim().to_owned();
        if !self.webhook_url.is_empty()
            && !self.webhook_url.starts_with("https://")
            && !self.webhook_url.starts_with("http://")
        {
            return Err(AppError::bad_request("invalid_webhook", "the webhook must be an http(s) URL"));
        }
        Ok(())
    }
}

/// The current settings, shared and cached in memory.
#[derive(Clone)]
pub struct SettingsStore {
    db: Db,
    keys: Keys,
    current: Arc<RwLock<Settings>>,
}

const KEY: &str = "app";
const TOKEN_KEY: &str = "twitch_token";

impl SettingsStore {
    pub async fn load(db: Db, keys: Keys) -> AppResult<Self> {
        let (stored, has_token) = db
            .read(|conn| {
                let stored: Option<String> =
                    conn.query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |row| row.get(0)).ok();
                let has_token =
                    conn.query_row("SELECT 1 FROM settings WHERE key = ?1", [TOKEN_KEY], |_| Ok(())).is_ok();
                Ok((stored, has_token))
            })
            .await?;
        let mut settings: Settings = stored.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
        settings.has_twitch_token = has_token;
        Ok(Self { db, keys, current: Arc::new(RwLock::new(settings)) })
    }

    pub async fn get(&self) -> Settings {
        self.current.read().await.clone()
    }

    pub async fn update(&self, mut settings: Settings) -> AppResult<Settings> {
        settings.validate()?;
        settings.has_twitch_token = self.current.read().await.has_twitch_token;
        let json = serde_json::to_string(&settings)?;
        self.db
            .write(move |conn| {
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    [KEY, json.as_str()],
                )?;
                Ok(())
            })
            .await?;
        *self.current.write().await = settings.clone();
        Ok(settings)
    }

    /// The Twitch `auth-token` cookie of an account (Turbo removes ads), decrypted.
    pub async fn twitch_token(&self) -> Option<String> {
        let keys = self.keys.clone();
        self.db
            .read(move |conn| {
                let sealed: String =
                    conn.query_row("SELECT value FROM settings WHERE key = ?1", [TOKEN_KEY], |row| row.get(0))?;
                Ok(keys.open(&sealed))
            })
            .await
            .ok()
            .flatten()
    }

    /// Stores (encrypted) or removes the Twitch token.
    pub async fn set_twitch_token(&self, token: Option<String>) -> AppResult<()> {
        let sealed = token
            .map(|token| token.trim().trim_start_matches("OAuth ").trim().to_owned())
            .filter(|token| !token.is_empty())
            .map(|token| {
                if token.len() > 64 || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Err(AppError::bad_request("invalid_token", "a Twitch token is 30 letters and digits"));
                }
                Ok(self.keys.seal(&token))
            })
            .transpose()?;
        let has_token = sealed.is_some();
        self.db
            .write(move |conn| {
                match sealed {
                    Some(sealed) => conn.execute(
                        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                        [TOKEN_KEY, sealed.as_str()],
                    )?,
                    None => conn.execute("DELETE FROM settings WHERE key = ?1", [TOKEN_KEY])?,
                };
                Ok(())
            })
            .await?;
        self.current.write().await.has_twitch_token = has_token;
        Ok(())
    }
}
