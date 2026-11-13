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
    pub record_chat: bool,
    /// Free space under which an alert is raised, in gigabytes.
    pub disk_warning_gb: u32,
    /// Free space under which new recordings don't start and the oldest unprotected are removed.
    pub disk_reserve_gb: u32,
    pub webhook_url: String,
    pub webhook_kind: WebhookKind,
    /// Where the Twitch token comes from: `config` (environment or argument), `stored` (saved from
    /// the interface by an earlier version), or none. The token itself is only sent on request.
    #[serde(skip_deserializing)]
    pub twitch_token_source: Option<TokenSource>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            retention_days: 14,
            h264_only: false,
            record_chat: true,
            disk_warning_gb: 20,
            disk_reserve_gb: 5,
            webhook_url: String::new(),
            webhook_kind: WebhookKind::Discord,
            twitch_token_source: None,
        }
    }
}

impl Settings {
    fn validate(&mut self) -> AppResult<()> {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenSource {
    Config,
    Stored,
}

/// The current settings, shared and cached in memory.
#[derive(Clone)]
pub struct SettingsStore {
    db: Db,
    keys: Keys,
    current: Arc<RwLock<Settings>>,
    /// The token from the configuration; it takes the place of one stored by an earlier version.
    config_token: Option<String>,
}

const KEY: &str = "app";
const TOKEN_KEY: &str = "twitch_token";

impl SettingsStore {
    pub async fn load(db: Db, keys: Keys, config_token: Option<String>) -> AppResult<Self> {
        let (stored, has_stored_token) = db
            .read(|conn| {
                let stored: Option<String> =
                    conn.query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |row| row.get(0)).ok();
                let has_token =
                    conn.query_row("SELECT 1 FROM settings WHERE key = ?1", [TOKEN_KEY], |_| Ok(())).is_ok();
                Ok((stored, has_token))
            })
            .await?;
        let mut settings: Settings = stored.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
        settings.twitch_token_source = if config_token.is_some() {
            // The configuration has its own: the one saved from the interface is no longer needed.
            if has_stored_token {
                db.write(|conn| {
                    conn.execute("DELETE FROM settings WHERE key = ?1", [TOKEN_KEY])?;
                    Ok(())
                })
                .await?;
                tracing::info!("Twitch token now read from the configuration; the stored one was removed");
            }
            Some(TokenSource::Config)
        } else if has_stored_token {
            Some(TokenSource::Stored)
        } else {
            None
        };
        Ok(Self { db, keys, current: Arc::new(RwLock::new(settings)), config_token })
    }

    pub async fn get(&self) -> Settings {
        self.current.read().await.clone()
    }

    pub async fn update(&self, mut settings: Settings) -> AppResult<Settings> {
        settings.validate()?;
        settings.twitch_token_source = self.current.read().await.twitch_token_source;
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

    /// The Twitch `auth-token` cookie of an account (Turbo removes ads): the configured one, or
    /// the one an earlier version stored (encrypted) from the interface.
    pub async fn twitch_token(&self) -> Option<String> {
        if let Some(token) = &self.config_token {
            return Some(token.clone());
        }
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
}
