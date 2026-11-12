//! Where recordings live on disk, and how chat time maps to video time.
//!
//! A broadcast has a folder under `streams/<login>/`. Each part of it (a new part starts when
//! the picture format changes) has its own video and timeline; the chat file is shared.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const CHAT_FILE: &str = "chat.ndjson";
pub const THUMBNAIL_FILE: &str = "thumbnail.jpg";

pub fn video_file(part: i64) -> String {
    if part <= 1 { "video.mp4".to_owned() } else { format!("video-{part}.mp4") }
}

pub fn timeline_file(part: i64) -> String {
    if part <= 1 { "timeline.json".to_owned() } else { format!("timeline-{part}.json") }
}

/// Resolves a stream's folder, refusing anything that would leave the streams directory.
pub fn stream_dir(streams_root: &Path, dir: &str) -> Option<PathBuf> {
    let relative = Path::new(dir);
    let safe = relative.components().all(|part| matches!(part, std::path::Component::Normal(_)));
    safe.then(|| streams_root.join(relative))
}

/// `2026-11-12_14-43-11`, in UTC, for folder names that sort by date.
pub fn folder_stamp(unix_ms: i64) -> String {
    let seconds = unix_ms.div_euclid(1000);
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Civil date from days, after Howard Hinnant's algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}_{:02}-{:02}-{:02}", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Points where video time and wall-clock time were matched: at the start, and after every
/// cut (skipped ad, lost segments). Between two points both run at the same pace.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Timeline {
    /// (video milliseconds, wall-clock Unix milliseconds)
    pub anchors: Vec<(i64, i64)>,
}

impl Timeline {
    pub fn load(path: &Path) -> Self {
        std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_vec(self)?)?;
        std::fs::rename(temporary, path)
    }

    /// Video time of a wall-clock moment. What was said during a cut shows at the cut.
    pub fn video_time(&self, wall: i64) -> Option<i64> {
        let index = self.anchors.partition_point(|&(_, anchor_wall)| anchor_wall <= wall);
        let (video, anchor_wall) = *self.anchors.get(index.checked_sub(1)?)?;
        let mut time = video + (wall - anchor_wall);
        if let Some(&(next_video, _)) = self.anchors.get(index) {
            time = time.min(next_video);
        }
        Some(time)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_chat_across_cuts() {
        // Recording starts at wall 1000; at video 10 s, 30 s of ads were cut.
        let timeline = Timeline { anchors: vec![(0, 1_000), (10_000, 41_000)] };
        assert_eq!(timeline.video_time(500), None);
        assert_eq!(timeline.video_time(6_000), Some(5_000));
        // Said during the ad: shown at the cut.
        assert_eq!(timeline.video_time(25_000), Some(10_000));
        assert_eq!(timeline.video_time(51_000), Some(20_000));
    }

    #[test]
    fn stamps_folders() {
        assert_eq!(folder_stamp(1_794_494_591_142), "2026-11-12_14-43-11");
        assert_eq!(folder_stamp(0), "1970-01-01_00-00-00");
    }

    #[test]
    fn refuses_escaping_paths() {
        let root = Path::new("/data/streams");
        assert!(stream_dir(root, "someone/2026-11-12_1").is_some());
        assert!(stream_dir(root, "../secret.key").is_none());
        assert!(stream_dir(root, "/etc").is_none());
    }
}
