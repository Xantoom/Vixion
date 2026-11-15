//! Broadcasts recorded in several parts become one recording.
//!
//! Before a restart could go on in the same file, each one left a new part behind: a broadcast
//! cut by three updates came as four recordings. At startup, the parts of a finished broadcast
//! that share their tracks are put end to end in the first part's file, their timelines and
//! chapters moved to follow on, and the other parts removed. The cut between two parts stays in
//! the timeline, so the player can show it.
//!
//! A part is appended, the file closed, then the database changed: a marker file in the folder
//! says how long the file was before, so a merge interrupted halfway starts again cleanly.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::storage::{self, Timeline};
use crate::app::AppState;
use crate::error::AppError;
use crate::media::fmp4::{Progress, Writer};

const MARKER: &str = "merging.json";

/// What was being appended when the merge was interrupted.
#[derive(Serialize, Deserialize)]
struct Marker {
    /// The part being appended.
    part: i64,
    /// The first part's file length, and video length in milliseconds, before it.
    length: u64,
    duration_ms: i64,
}

#[derive(Clone)]
struct Row {
    id: i64,
    part: i64,
    status: String,
    ended_at: Option<i64>,
    ads_ms: i64,
    chat: i64,
    gaps: i64,
    keep: bool,
    thumbnail: bool,
    error: Option<String>,
}

/// Merges the parts of every finished broadcast. Runs once at startup, before recording.
pub async fn run(app: &AppState) {
    let dirs = app
        .db
        .read(|conn| {
            let mut statement = conn.prepare(
                "SELECT dir FROM streams GROUP BY dir
                 HAVING COUNT(*) > 1 AND SUM(status = 'recording') = 0 ORDER BY MIN(started_at)",
            )?;
            let dirs = statement.query_map([], |row| row.get::<_, String>(0))?;
            Ok(dirs.collect::<Result<Vec<_>, _>>()?)
        })
        .await
        .unwrap_or_default();
    for dir in dirs {
        if let Err(error) = merge_dir(app, &dir).await {
            tracing::warn!(dir, %error, "can't merge a broadcast's parts");
        }
    }
}

async fn merge_dir(app: &AppState, dir: &str) -> Result<(), AppError> {
    let Some(folder) = storage::stream_dir(&app.config.streams_dir(), dir) else { return Ok(()) };
    let owned = dir.to_owned();
    let rows = app
        .db
        .read(move |conn| {
            let mut statement = conn.prepare(
                "SELECT id, part, status, ended_at, ads_skipped_ms, chat_messages, gaps, keep_forever, has_thumbnail,
                 error FROM streams WHERE dir = ?1 ORDER BY part",
            )?;
            let rows = statement.query_map([owned], |row| {
                Ok(Row {
                    id: row.get(0)?,
                    part: row.get(1)?,
                    status: row.get(2)?,
                    ended_at: row.get(3)?,
                    ads_ms: row.get(4)?,
                    chat: row.get(5)?,
                    gaps: row.get(6)?,
                    keep: row.get::<_, i64>(7)? != 0,
                    thumbnail: row.get::<_, i64>(8)? != 0,
                    error: row.get(9)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await?;
    let Some((first, rest)) = rows.split_first() else { return Ok(()) };
    let marker_path = folder.join(MARKER);
    let base_video = folder.join(storage::video_file(first.part));

    // An earlier merge stopped halfway: the first part goes back to how it was before it.
    if let Some(marker) =
        tokio::fs::read(&marker_path).await.ok().and_then(|bytes| serde_json::from_slice::<Marker>(&bytes).ok())
    {
        if rest.iter().any(|row| row.part == marker.part) {
            let file = tokio::fs::OpenOptions::new().write(true).open(&base_video).await.map_err(io)?;
            file.set_len(marker.length).await.map_err(io)?;
            let (folder, part) = (folder.clone(), first.part);
            tokio::task::spawn_blocking(move || restore_timeline(&folder, part, marker.duration_ms))
                .await
                .map_err(|error| AppError::internal(format!("merge task: {error}")).with_source(error))?;
        }
        let _ = tokio::fs::remove_file(&marker_path).await;
    }

    let mut merged = first.clone();
    for other in rest {
        let other_video = folder.join(storage::video_file(other.part));
        if !tokio::fs::metadata(&other_video).await.is_ok_and(|meta| meta.is_file()) {
            break;
        }
        tracing::info!(dir, part = other.part, "merging a part of a broadcast");
        let (base, theirs, marker, part, base_part) =
            (base_video.clone(), other_video.clone(), marker_path.clone(), other.part, first.part);
        let folder_for_files = folder.clone();
        let appended = tokio::task::spawn_blocking(move || -> std::io::Result<Option<(i64, i64, Progress, u32)>> {
            let mut writer = Writer::resume(&base)?;
            let before = writer.progress();
            let length = before.bytes;
            let note = Marker { part, length, duration_ms: before.duration_ms };
            std::fs::write(&marker, serde_json::to_vec(&note).unwrap_or_default())?;
            // What both parts recorded (the playlist a restart begins with goes back a little)
            // is left out of the second one.
            let folder = &folder_for_files;
            let base_end =
                Timeline::load(&folder.join(storage::timeline_file(base_part))).wall_time(before.duration_ms);
            let other_start = Timeline::load(&folder.join(storage::timeline_file(part))).anchors.first().map(|a| a.1);
            let overlap = match (base_end, other_start) {
                (Some(end), Some(start)) => (end - start).clamp(0, 120_000),
                _ => 0,
            };
            let (shift, skipped) = match writer.append(&theirs, overlap) {
                Ok(moved) => moved,
                Err(error) => {
                    // Not the same tracks (the picture changed): this part stays apart.
                    tracing::info!(%error, "a part stays apart");
                    drop(writer);
                    std::fs::OpenOptions::new().write(true).open(&base)?.set_len(length)?;
                    Writer::resume(&base)?.finish()?;
                    let _ = std::fs::remove_file(&marker);
                    return Ok(None);
                }
            };
            let gaps = writer.discontinuities;
            let progress = writer.finish()?;
            merge_timelines(folder, base_part, part, before.duration_ms, shift, skipped)?;
            Ok(Some((shift, before.duration_ms, progress, gaps)))
        })
        .await
        .map_err(|error| AppError::internal(format!("merge task: {error}")).with_source(error))?
        .map_err(io)?;
        let Some((shift, joined_at, progress, gaps)) = appended else { break };

        merged.ads_ms += other.ads_ms;
        merged.chat += other.chat;
        merged.gaps += other.gaps + i64::from(gaps);
        merged.keep |= other.keep;
        merged.thumbnail |= other.thumbnail;
        merged.ended_at = other.ended_at.or(merged.ended_at);
        merged.status = if other.status == "failed" { other.status.clone() } else { merged.status };
        merged.error = other.error.clone().or(merged.error);
        let (row, removed) = (merged.clone(), other.id);
        app.db
            .write(move |conn| {
                let tx = conn.transaction()?;
                tx.execute(
                    "INSERT OR REPLACE INTO stream_chapters (stream_id, at_ms, title, game)
                     SELECT ?1, MAX(at_ms + ?3, ?4), title, game FROM stream_chapters WHERE stream_id = ?2",
                    rusqlite::params![row.id, removed, shift, joined_at],
                )?;
                tx.execute(
                    "UPDATE streams SET duration_ms = ?2, size_bytes = ?3, fps = ?4, ads_skipped_ms = ?5,
                     chat_messages = ?6, gaps = ?7, keep_forever = ?8, has_thumbnail = ?9, ended_at = ?10,
                     status = ?11, error = ?12 WHERE id = ?1",
                    rusqlite::params![
                        row.id,
                        progress.duration_ms,
                        i64::try_from(progress.bytes).unwrap_or(i64::MAX),
                        progress.fps,
                        row.ads_ms,
                        row.chat,
                        row.gaps,
                        row.keep,
                        row.thumbnail,
                        row.ended_at,
                        row.status,
                        row.error
                    ],
                )?;
                tx.execute("DELETE FROM streams WHERE id = ?1", [removed])?;
                // Each part began with a chapter: where nothing changed, the one before goes on.
                tx.execute(
                    "DELETE FROM stream_chapters AS c WHERE stream_id = ?1 AND at_ms > 0 AND EXISTS (
                         SELECT 1 FROM stream_chapters p WHERE p.stream_id = c.stream_id
                         AND p.at_ms = (SELECT MAX(at_ms) FROM stream_chapters q WHERE q.stream_id = c.stream_id
                                        AND q.at_ms < c.at_ms)
                         AND p.title = c.title AND p.game IS c.game)",
                    [row.id],
                )?;
                tx.commit()?;
                Ok(())
            })
            .await?;
        let _ = tokio::fs::remove_file(&marker_path).await;
        let _ = tokio::fs::remove_file(&other_video).await;
        let _ = tokio::fs::remove_file(folder.join(storage::timeline_file(other.part))).await;
        tracing::info!(dir, part = other.part, into = first.id, "part merged");
    }
    Ok(())
}

/// Internal whatever its kind: a missing file during a merge is a failure, not a 404.
fn io(error: std::io::Error) -> AppError {
    AppError::internal(format!("io: {error}")).with_source(error)
}

/// The first part's timeline, followed by the other's moved by `shift` from where it was kept
/// (`skipped` in), with a cut where they join. Points the first part had past `duration_ms` came
/// from an interrupted merge and are dropped.
fn merge_timelines(
    folder: &Path,
    base: i64,
    other: i64,
    duration_ms: i64,
    shift: i64,
    skipped: i64,
) -> std::io::Result<()> {
    let path: PathBuf = folder.join(storage::timeline_file(base));
    let mut timeline = Timeline::load(&path);
    timeline.anchors.retain(|&(video, _)| video < duration_ms);
    timeline.cuts.retain(|&video| video < duration_ms);
    let theirs = Timeline::load(&folder.join(storage::timeline_file(other)));
    if let Some(wall) = theirs.wall_time(skipped) {
        timeline.anchors.push((duration_ms, wall));
    }
    timeline.anchors.extend(theirs.anchors.iter().filter(|(video, _)| *video > skipped).map(|&(v, w)| (v + shift, w)));
    timeline.cuts.push(duration_ms);
    timeline.cuts.extend(theirs.cuts.iter().filter(|video| **video > skipped).map(|video| video + shift));
    timeline.save(&path)
}

fn restore_timeline(folder: &Path, base: i64, duration_ms: i64) {
    let path = folder.join(storage::timeline_file(base));
    let mut timeline = Timeline::load(&path);
    timeline.anchors.retain(|&(video, _)| video < duration_ms);
    timeline.cuts.retain(|&video| video < duration_ms);
    let _ = timeline.save(&path);
}
