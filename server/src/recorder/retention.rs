//! Keeping the disk in check: recordings past their retention go, and when space runs out the
//! oldest unprotected ones go first. Also repairs recordings a crash interrupted.

use std::time::Duration;

use rusqlite::OptionalExtension as _;

use super::storage;
use crate::alerts::Level;
use crate::app::AppState;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::media::fmp4;
use crate::system;

const GIB: u64 = 1 << 30;

/// Who asks for a deletion, which decides what stops it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Deletion {
    /// Someone asked for it: anything but a recording in progress.
    Manual,
    /// Retention or a full disk: only what isn't kept forever, nor recording.
    Automatic,
}

/// Deletes a recording part: its row, then its files, and its folder once no other part uses it.
/// Returns false when the part is protected (or already gone) and was left alone.
///
/// The row goes and the remaining parts are counted in one transaction, checked against its
/// status at that moment: two deletions at once can't each leave the folder to the other, a
/// part kept or resumed since it was picked stays, and a resumed part can't lose its files
/// (a resume marks the row recording before it touches them).
pub async fn delete_stream(app: &AppState, id: i64, by: Deletion) -> AppResult<bool> {
    // Retention starts once the merge is over; someone may ask sooner.
    if super::merge::running() {
        return Err(AppError::conflict("merging", "recordings are being merged, try again in a moment"));
    }
    let found = app
        .db
        .write(move |conn| {
            let tx = conn.transaction()?;
            let row: Option<(String, i64, String, bool)> = tx
                .query_row("SELECT dir, part, status, keep_forever FROM streams WHERE id = ?1", [id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .optional()?;
            let Some((dir, part, status, keep)) = row else { return Ok(None) };
            if status == "recording" {
                return match by {
                    Deletion::Manual => Err(AppError::conflict("recording", "stop the recording first")),
                    Deletion::Automatic => Ok(None),
                };
            }
            if keep && by == Deletion::Automatic {
                return Ok(None);
            }
            tx.execute("DELETE FROM streams WHERE id = ?1", [id])?;
            let shared: i64 = tx.query_row("SELECT COUNT(*) FROM streams WHERE dir = ?1", [&dir], |row| row.get(0))?;
            tx.commit()?;
            Ok(Some((dir, part, shared > 0)))
        })
        .await?;
    let Some((dir, part, shared)) = found else { return Ok(false) };
    let Some(folder) = storage::stream_dir(&app.config.streams_dir(), &dir) else { return Ok(true) };
    let removed = if shared {
        let mut removed = Ok(());
        for file in [storage::video_file(part), storage::timeline_file(part)] {
            match tokio::fs::remove_file(folder.join(file)).await {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => removed = Err(error),
                _ => {}
            }
        }
        removed
    } else {
        let removed = match tokio::fs::remove_dir_all(&folder).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        };
        // The streamer's folder goes too once empty; failing means it isn't.
        if let Some(parent) = folder.parent() {
            let _ = tokio::fs::remove_dir(parent).await;
        }
        removed
    };
    // The row is gone already: files that resist are reported, not a reason to fail.
    if let Err(error) = removed {
        tracing::error!(%error, folder = %folder.display(), "a deleted recording left files behind");
    }
    Ok(true)
}

/// Deletes expired recordings every hour, and once at start. Free space is watched every minute,
/// since a long broadcast fills a disk much faster than that.
pub async fn run(app: AppState) {
    let mut minutes = 0u32;
    loop {
        let result = if minutes.is_multiple_of(60) { sweep(&app).await } else { check_disk(&app, true).await };
        if let Err(error) = result {
            tracing::error!(%error, "retention sweep failed");
        }
        // Caches filled by viewers empty out when nobody watches.
        app.chat_assets.purge();
        crate::api::streams::purge_chat_cache();
        minutes = minutes.wrapping_add(1);
        tokio::time::sleep(Duration::from_secs(60)).await;
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
    let mut deleted = 0;
    for id in expired {
        match delete_stream(app, id, Deletion::Automatic).await {
            Ok(true) => deleted += 1,
            Ok(false) => {}
            Err(error) => tracing::warn!(%error, id, "can't delete an expired recording"),
        }
    }
    if deleted > 0 {
        tracing::info!(count = deleted, "expired recordings deleted");
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
            if delete_stream(app, id, Deletion::Automatic).await.unwrap_or(false) {
                freed += u64::try_from(size).unwrap_or(0);
                deleted += 1;
            }
        }
        if deleted > 0 {
            app.alerts
                .event(
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

/// Recordings left `recording` by a crash (of the process, or of one streamer's recording when
/// `streamer` is given) are repaired and closed.
pub async fn recover(app: &AppState, streamer: Option<i64>) -> AppResult<()> {
    let interrupted = app
        .db
        .read(move |conn| {
            let mut statement = conn.prepare(
                "SELECT id, dir, part FROM streams WHERE status = 'recording' AND (?1 IS NULL OR streamer_id = ?1)",
            )?;
            let rows = statement.query_map([streamer], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
            })?;
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
