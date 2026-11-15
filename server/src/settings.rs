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
        // Cloud metadata services hand out credentials: never a webhook.
        let host = self
            .webhook_url
            .split_once("://")
            .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default())
            .map(|authority| authority.rsplit('@').next().unwrap_or_default().to_ascii_lowercase())
            .unwrap_or_default();
        let host = host.strip_prefix('[').map_or_else(
            || host.split(':').next().unwrap_or_default().to_owned(),
            |v6| v6.split(']').next().unwrap_or_default().to_owned(),
        );
        if host.starts_with("169.254.") || host == "metadata.google.internal" || host.starts_with("fd00:ec2:") {
            return Err(AppError::bad_request("invalid_webhook", "this address can't receive alerts"));
        }
        Ok(())
    }
}

/// Stored settings, read one field at a time: a value this version can't read (written by
/// another version, say) falls back to its default alone, never taking the others with it. A
/// retention of "forever" must not turn into fourteen days because of an unrelated field.
fn parse(json: &str) -> Settings {
    let Ok(serde_json::Value::Object(stored)) = serde_json::from_str::<serde_json::Value>(json) else {
        tracing::warn!("the stored settings can't be read: defaults are used");
        return Settings::default();
    };
    let Ok(serde_json::Value::Object(mut merged)) = serde_json::to_value(Settings::default()) else {
        return Settings::default();
    };
    for (key, value) in stored {
        let previous = merged.insert(key.clone(), value);
        if serde_json::from_value::<Settings>(serde_json::Value::Object(merged.clone())).is_err() {
            tracing::warn!(setting = key, "a stored setting can't be read: its default is used");
            match previous {
                Some(previous) => merged.insert(key, previous),
                None => merged.remove(&key),
            };
        }
    }
    serde_json::from_value(serde_json::Value::Object(merged)).unwrap_or_default()
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

/// The retention saved last, for code that maps database rows and has no store at hand. Only
/// the store sets it, when it loads and saves the settings.
static RETENTION_DAYS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// How many days recordings are kept by default, as saved last; 0 keeps them forever.
pub fn retention_days() -> u32 {
    RETENTION_DAYS.load(std::sync::atomic::Ordering::Relaxed)
}

fn remember_retention(settings: &Settings) {
    RETENTION_DAYS.store(settings.retention_days, std::sync::atomic::Ordering::Relaxed);
}
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
        let mut settings = stored.map(|json| parse(&json)).unwrap_or_default();
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
        remember_retention(&settings);
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
        remember_retention(&settings);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_unreadable_setting_keeps_the_others() {
        let settings = parse(r#"{"retention_days":0,"webhook_kind":"carrier-pigeon","h264_only":true,"later":1}"#);
        assert_eq!(settings.retention_days, 0);
        assert!(settings.h264_only);
        assert_eq!(settings.webhook_kind, WebhookKind::Discord);
    }

    #[test]
    fn unreadable_settings_fall_back_to_defaults() {
        assert_eq!(parse("not json").retention_days, 14);
        assert_eq!(parse(r#"{"retention_days":"forever"}"#).retention_days, 14);
    }
}
