//! Alerts: problems an administrator should know about, shown in the app and sent to a webhook.
//!
//! An alert of a kind stays open until resolved; raising the same kind again while it is open
//! does nothing, so a failing channel doesn't flood the webhook.

use std::time::Duration;

use serde::Serialize;
use serde_json::json;

use crate::db::{Db, now_ms};
use crate::error::AppResult;
use crate::settings::{SettingsStore, WebhookKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warning,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Alert {
    pub id: i64,
    pub level: String,
    pub kind: String,
    pub message: String,
    pub created_at: i64,
    pub resolved: bool,
}

#[derive(Clone)]
pub struct Alerts {
    db: Db,
    settings: SettingsStore,
    http: reqwest::Client,
}

impl Alerts {
    pub fn new(db: Db, settings: SettingsStore, http: reqwest::Client) -> Self {
        Self { db, settings, http }
    }

    /// Opens an alert of `kind` unless one is already open. Never fails: alerts report failures.
    pub async fn raise(&self, level: Level, kind: impl Into<String>, message: impl Into<String>) {
        let kind = kind.into();
        let message = message.into();
        match level {
            Level::Error => tracing::error!(%kind, "{message}"),
            Level::Warning => tracing::warn!(%kind, "{message}"),
            Level::Info => tracing::info!(%kind, "{message}"),
        }
        let (stored_kind, stored_message) = (kind.clone(), message.clone());
        let inserted = self
            .db
            .write(move |conn| {
                let open = conn
                    .query_row("SELECT 1 FROM alerts WHERE kind = ?1 AND resolved = 0", [&stored_kind], |_| Ok(()))
                    .is_ok();
                if open {
                    return Ok(false);
                }
                conn.execute(
                    "INSERT INTO alerts (level, kind, message, created_at) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![level.as_str(), stored_kind, stored_message, now_ms()],
                )?;
                // A year of alerts is plenty.
                conn.execute("DELETE FROM alerts WHERE created_at < ?1", [now_ms() - 365 * 86_400_000])?;
                Ok(true)
            })
            .await
            .unwrap_or(false);
        if inserted {
            self.notify(level, kind, message);
        }
    }

    /// Records something that happened once (it needs no resolving) and sends it every time.
    pub async fn event(&self, level: Level, kind: impl Into<String>, message: impl Into<String>) {
        let (kind, message) = (kind.into(), message.into());
        tracing::warn!(%kind, "{message}");
        let (stored_kind, stored_message) = (kind.clone(), message.clone());
        let _ = self
            .db
            .write(move |conn| {
                conn.execute(
                    "INSERT INTO alerts (level, kind, message, created_at, resolved) VALUES (?1, ?2, ?3, ?4, 1)",
                    rusqlite::params![level.as_str(), stored_kind, stored_message, now_ms()],
                )?;
                Ok(())
            })
            .await;
        self.notify(level, kind, message);
    }

    /// Closes the open alert of `kind`, if any.
    pub async fn resolve(&self, kind: &str) {
        let kind = kind.to_owned();
        let _ = self
            .db
            .write(move |conn| {
                conn.execute("UPDATE alerts SET resolved = 1 WHERE kind = ?1 AND resolved = 0", [kind])?;
                Ok(())
            })
            .await;
    }

    pub async fn list(&self, open_only: bool) -> AppResult<Vec<Alert>> {
        self.db
            .read(move |conn| {
                let mut statement = conn.prepare_cached(
                    // Every open alert, however old, and the latest of the others.
                    "SELECT id, level, kind, message, created_at, resolved FROM alerts
                     WHERE resolved = 0 OR (?1 = 0 AND id IN (SELECT id FROM alerts WHERE resolved = 1
                       ORDER BY created_at DESC LIMIT 200))
                     ORDER BY created_at DESC",
                )?;
                let rows = statement.query_map([i64::from(open_only)], |row| {
                    Ok(Alert {
                        id: row.get(0)?,
                        level: row.get(1)?,
                        kind: row.get(2)?,
                        message: row.get(3)?,
                        created_at: row.get(4)?,
                        resolved: row.get::<_, i64>(5)? != 0,
                    })
                })?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .await
    }

    pub async fn dismiss(&self, id: i64) -> AppResult<()> {
        self.db
            .write(move |conn| {
                conn.execute("UPDATE alerts SET resolved = 1 WHERE id = ?1", [id])?;
                Ok(())
            })
            .await
    }

    /// Sends to the webhook in the background: a slow webhook never holds up the recorder.
    fn notify(&self, level: Level, kind: String, message: String) {
        let this = self.clone();
        tokio::spawn(async move { this.send(level, &kind, &message).await });
    }

    async fn send(&self, level: Level, kind: &str, message: &str) {
        let settings = self.settings.get().await;
        if settings.webhook_url.is_empty() || level == Level::Info {
            return;
        }
        let title = format!("Vixion {}", level.as_str());
        let request = match settings.webhook_kind {
            WebhookKind::Discord => {
                self.http.post(&settings.webhook_url).json(&json!({ "content": format!("**{title}**: {message}") }))
            }
            WebhookKind::Ntfy => self
                .http
                .post(&settings.webhook_url)
                .header("Title", title)
                .header("Priority", if level == Level::Error { "high" } else { "default" })
                .header("Tags", "vixion")
                .body(message.to_owned()),
            WebhookKind::Generic => self.http.post(&settings.webhook_url).json(&json!({
                "level": level.as_str(), "kind": kind, "message": message, "at": now_ms(),
            })),
        };
        match request.timeout(Duration::from_secs(10)).send().await {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => tracing::warn!(status = %response.status(), "the alert webhook refused the alert"),
            Err(error) => tracing::warn!(%error, "the alert webhook is unreachable"),
        }
    }
}
