//! Keeping the disk in check: recordings past their retention go, and when space runs out the
//! oldest unprotected ones go first. Also repairs recordings a crash interrupted.

use std::time::Duration;

use super::storage;
use crate::alerts::Level;
use crate::app::AppState;
use crate::db::now_ms;
use crate::error::AppResult;
use crate::media::fmp4;
use crate::system;

const GIB: u64 = 1 << 30;

/// Deletes a recording part: its files, its folder once no other part uses it, and its row.
pub async fn delete_stream(app: &AppState, id: i64) -> AppResult<()> {
    let (dir, part, shared) = app
        .db
        .read(move |conn| {
            let (dir, part): (String, i64) =
                conn.query_row("SELECT dir, part FROM streams WHERE id = ?1", [id], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?;
            let shared: i64 = conn.query_row(
                "SELECT COUNT(*) FROM streams WHERE dir = ?1 AND id != ?2",
                rusqlite::params![dir, id],
                |row| row.get(0),
            )?;
            Ok((dir, part, shared > 0))
        })
        .await?;
    if let Some(folder) = storage::stream_dir(&app.config.streams_dir(), &dir) {
        if shared {
            for file in [storage::video_file(part), storage::timeline_file(part)] {
                match tokio::fs::remove_file(folder.join(file)).await {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        } else {
            match tokio::fs::remove_dir_all(&folder).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            // The streamer's folder goes too once empty; failing means it isn't.
            if let Some(parent) = folder.parent() {
                let _ = tokio::fs::remove_dir(parent).await;
            }
        }
    }
    app.db
        .write(move |conn| {
            conn.execute("DELETE FROM streams WHERE id = ?1", [id])?;
            Ok(())
        })
        .await
}

/// Runs the clean-up every hour, and once at start.
pub async fn run(app: AppState) {
    loop {
        if let Err(error) = sweep(&app).await {
            tracing::error!(%error, "retention sweep failed");
        }
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

pub async fn sweep(app: &AppState) -> AppResult<()> {
    let settings = app.settings.get().await;
    let global = i64::from(settings.retention_days);
    let now = now_ms();
    let expired = app
        .db
        .read(move |conn| {
            let mut statement = conn.prepare_cached(
                "SELECT s.id FROM streams s JOIN streamers st ON st.id = s.streamer_id
                 WHERE s.keep_forever = 0 AND s.status != 'recording'
                   AND COALESCE(st.retention_days, ?1) > 0
                   AND s.started_at < ?2 - COALESCE(st.retention_days, ?1) * 86400000",
            )?;
            let rows = statement.query_map(rusqlite::params![global, now], |row| row.get::<_, i64>(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    for id in &expired {
        if let Err(error) = delete_stream(app, *id).await {
            tracing::warn!(%error, id, "can't delete an expired recording");
        }
    }
    if !expired.is_empty() {
        tracing::info!(count = expired.len(), "expired recordings deleted");
    }
    check_disk(app, true).await
}

/// Raises or clears the low-space alert, and frees space under the reserve when allowed.
pub async fn check_disk(app: &AppState, free_space: bool) -> AppResult<()> {
    let settings = app.settings.get().await;
    let root = app.config.streams_dir();
    let Some(mut space) = system::disk_space(&root) else { return Ok(()) };
    let reserve = u64::from(settings.disk_reserve_gb) * GIB;
    if free_space && space.free < reserve {
        let oldest = app
            .db
            .read(|conn| {
                let mut statement = conn.prepare_cached(
                    "SELECT id, size_bytes FROM streams WHERE keep_forever = 0 AND status IN ('done', 'failed')
                     ORDER BY started_at ASC LIMIT 200",
                )?;
                let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .await?;
        let mut freed = 0u64;
        let mut deleted = 0;
        for (id, size) in oldest {
            if space.free + freed >= reserve {
                break;
            }
            if delete_stream(app, id).await.is_ok() {
                freed += u64::try_from(size).unwrap_or(0);
                deleted += 1;
            }
        }
        if deleted > 0 {
            app.alerts
                .raise(
                    Level::Warning,
                    "disk_reserve",
                    format!(
                        "Disk almost full: {deleted} oldest recordings deleted to keep {} GB free",
                        settings.disk_reserve_gb
                    ),
                )
                .await;
        }
        space = system::disk_space(&root).unwrap_or(space);
    }
    if space.free < u64::from(settings.disk_warning_gb) * GIB {
        app.alerts
            .raise(
                Level::Warning,
                "disk_low",
                format!("Only {:.1} GB free for recordings", space.free as f64 / GIB as f64),
            )
            .await;
    } else {
        app.alerts.resolve("disk_low").await;
    }
    Ok(())
}

/// Whether there is room to start a recording.
pub async fn room_to_record(app: &AppState) -> bool {
    let reserve = u64::from(app.settings.get().await.disk_reserve_gb) * GIB;
    system::disk_space(&app.config.streams_dir()).is_none_or(|space| space.free >= reserve)
}

/// Recordings left `recording` by a crash are repaired and closed.
pub async fn recover(app: &AppState) -> AppResult<()> {
    let interrupted = app
        .db
        .read(|conn| {
            let mut statement = conn.prepare("SELECT id, dir, part FROM streams WHERE status = 'recording'")?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    for (id, dir, part) in interrupted {
        let Some(folder) = storage::stream_dir(&app.config.streams_dir(), &dir) else { continue };
        let video = folder.join(storage::video_file(part));
        let repaired = tokio::task::spawn_blocking(move || fmp4::repair(&video)).await;
        let (status, progress, error) = match repaired {
            Ok(Ok(progress)) => ("done", progress, Some("interrupted by a restart".to_owned())),
            Ok(Err(error)) => ("failed", fmp4::Progress::default(), Some(format!("unrecoverable: {error}"))),
            Err(error) => ("failed", fmp4::Progress::default(), Some(error.to_string())),
        };
        tracing::warn!(id, status, "recovered an interrupted recording");
        app.db
            .write(move |conn| {
                conn.execute(
                    "UPDATE streams SET status = ?2, ended_at = COALESCE(ended_at, ?3),
                     duration_ms = CASE WHEN ?4 > 0 THEN ?4 ELSE duration_ms END,
                     size_bytes = CASE WHEN ?5 > 0 THEN ?5 ELSE size_bytes END, error = ?6 WHERE id = ?1",
                    rusqlite::params![
                        id,
                        status,
                        now_ms(),
                        progress.duration_ms,
                        i64::try_from(progress.bytes).unwrap_or(0),
                        error
                    ],
                )?;
                Ok(())
            })
            .await?;
    }
    Ok(())
}
