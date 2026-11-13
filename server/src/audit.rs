//! A lasting record of what people changed: accounts, roles, settings, recordings, and who saw
//! the Twitch token. Unlike the console, it survives restarts; entries go after a year.

use crate::app::AppState;
use crate::auth::CurrentUser;
use crate::db::now_ms;

/// Records an action. Never fails the request it belongs to: a failure is only logged.
pub async fn record(app: &AppState, user: &CurrentUser, action: &'static str, detail: impl Into<String>) {
    let (user_id, detail) = (user.id, detail.into());
    let result = app
        .db
        .write(move |conn| {
            let now = now_ms();
            conn.execute(
                "INSERT INTO audit_log (user_id, action, detail, created_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![user_id, action, detail, now],
            )?;
            conn.execute("DELETE FROM audit_log WHERE created_at < ?1", [now - 365 * 86_400_000])?;
            Ok(())
        })
        .await;
    if let Err(error) = result {
        tracing::warn!(%error, action, "can't write the audit log");
    }
}
