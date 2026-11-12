//! Turns Twitch's HLS segments into one fragmented MP4 per recording, without re-encoding.
//!
//! Twitch sends H.264 in MPEG-TS and HEVC or AV1 in fragmented MP4. Both are demuxed into the
//! same [`Sample`]s and written by [`fmp4::Writer`], which also removes the gaps left by skipped
//! ads so the timeline stays continuous.

pub mod aac;
pub mod bits;
pub mod fmp4;
pub mod h264;
pub mod mp4read;
pub mod ts;

use bytes::Bytes;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Video,
    Audio,
}

/// What a decoder needs to know about a track, and how it is described in the MP4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackConfig {
    pub kind: TrackKind,
    pub timescale: u32,
    /// The complete sample entry box (`avc1`, `hvc1`, `av01`, `mp4a`…), header included.
    pub sample_entry: Vec<u8>,
    /// Short codec name for people: `h264`, `hevc`, `av1`, `aac`, `opus`.
    pub codec: &'static str,
    pub width: u32,
    pub height: u32,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone)]
pub struct Sample {
    /// Decode time, in the track's timescale.
    pub dts: i64,
    /// Presentation time minus decode time.
    pub cts_offset: i32,
    /// Filled in by the demuxer when known; the writer fixes the last one of a segment.
    pub duration: u32,
    pub keyframe: bool,
    pub data: Bytes,
}

#[derive(Debug, Clone)]
pub struct TrackData {
    pub config: TrackConfig,
    pub samples: Vec<Sample>,
}

/// One HLS segment, demuxed.
#[derive(Debug, Default, Clone)]
pub struct Segment {
    pub video: Option<TrackData>,
    pub audio: Option<TrackData>,
}

impl Segment {
    pub fn is_empty(&self) -> bool {
        self.video.as_ref().is_none_or(|track| track.samples.is_empty())
            && self.audio.as_ref().is_none_or(|track| track.samples.is_empty())
    }
}

#[derive(Debug)]
pub struct MediaError(pub String);

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MediaError {}

pub(crate) fn err<T>(message: impl Into<String>) -> Result<T, MediaError> {
    Err(MediaError(message.into()))
}

/// Builds an MP4 box: size, type, then `body`.
pub(crate) fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(&u32::try_from(body.len() + 8).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

/// Builds a full box: a box whose body starts with a version byte and 24 bits of flags.
pub(crate) fn full_box(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut content = Vec::with_capacity(body.len() + 4);
    content.push(version);
    content.extend_from_slice(&flags.to_be_bytes()[1..]);
    content.extend_from_slice(body);
    mp4_box(kind, &content)
}
