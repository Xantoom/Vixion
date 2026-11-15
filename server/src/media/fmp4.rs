//! Fragmented MP4 writer.
//!
//! One fragment per HLS segment, written as it arrives, so a recording can be watched while it
//! records. When it ends, a `mfra` index is appended and the duration is patched into the init,
//! so players seek without scanning the file.
//!
//! The timeline is rebuilt continuous: when the source jumps (an ad was cut out, the encoder
//! restarted, a segment was lost), the next fragment starts where the previous one ended, with
//! the same shift on every track so sound and picture stay together.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use super::{Sample, Segment, TrackConfig, TrackData, TrackKind, full_box, mp4_box};

/// Movie timescale for the overall duration: milliseconds.
const MOVIE_TIMESCALE: u32 = 1000;
/// A jump larger than this between segments is a discontinuity, in seconds.
const MAX_DRIFT: f64 = 1.0;
const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

/// A seek index entry: (decode time, moof offset, traf number).
type IndexEntry = (i64, u64, u8);

struct Track {
    id: u32,
    config: TrackConfig,
    /// Added to source decode times.
    offset: i64,
    /// Output decode time after the last sample written or pending.
    end: i64,
    index: Vec<IndexEntry>,
}

struct Fragment {
    /// Per track (by index into `tracks`), samples with output times.
    tracks: Vec<(usize, Vec<Sample>)>,
}

/// What a finished or running recording measures.
#[derive(Debug, Clone, Copy, Default)]
pub struct Progress {
    pub duration_ms: i64,
    pub bytes: u64,
    pub fps: f64,
}

pub struct Writer {
    out: BufWriter<File>,
    position: u64,
    tracks: Vec<Track>,
    sequence: u32,
    /// Byte offset of the duration field of `mehd`, patched at the end.
    duration_at: u64,
    pending: Option<Fragment>,
    /// Source time (seconds) the next segment is expected to start at.
    expected: Option<f64>,
    /// Output seconds shift applied to source times.
    shift: f64,
    video_frames: u64,
    pub discontinuities: u32,
    /// Reopened after a stop: the first segment written is a cut, not the start.
    resumed: bool,
}

fn timescaled(seconds: f64, timescale: u32) -> i64 {
    (seconds * f64::from(timescale)).round() as i64
}

fn start_seconds(track: &TrackData) -> Option<f64> {
    track.samples.first().map(|sample| sample.dts as f64 / f64::from(track.config.timescale))
}

impl Writer {
    /// Creates the file and writes its init segment.
    pub fn create(path: &Path, video: Option<&TrackConfig>, audio: Option<&TrackConfig>) -> std::io::Result<Self> {
        let mut tracks = Vec::new();
        for config in [video, audio].into_iter().flatten() {
            tracks.push(Track {
                id: u32::try_from(tracks.len() + 1).unwrap_or(1),
                config: config.clone(),
                offset: 0,
                end: 0,
                index: Vec::new(),
            });
        }
        let (init, duration_at) = init_segment(&tracks);
        let mut out = BufWriter::with_capacity(1 << 20, File::create(path)?);
        out.write_all(&init)?;
        out.flush()?;
        Ok(Self {
            out,
            position: init.len() as u64,
            tracks,
            sequence: 0,
            duration_at,
            pending: None,
            expected: None,
            shift: 0.0,
            video_frames: 0,
            discontinuities: 0,
            resumed: false,
        })
    }

    /// Reopens a recording to write on at its end, as after a restart: its index is dropped
    /// (written again by [`Writer::finish`]) and so is a fragment torn by a crash. The next
    /// segment starts where the file ends, whatever its source time: that is a cut.
    ///
    /// Only the fragment headers are read, never the media, so it is quick on a long recording.
    pub fn resume(path: &Path) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
        let length = file.metadata()?.len();
        let (head, first) = read_head(&file, length)?;
        let init = super::mp4read::parse_init(&head).map_err(|error| invalid(&error.0))?;
        let duration_at = mehd_duration_offset(&head).ok_or_else(|| invalid("no mehd box"))?;
        let mut tracks: Vec<Track> = init
            .tracks
            .iter()
            .map(|t| Track { id: t.id, config: t.config.clone(), offset: 0, end: 0, index: Vec::new() })
            .collect();
        let (mut sequence, mut frames) = (0u32, 0u64);
        let complete = walk(&file, first, length, |fragment| {
            sequence += 1;
            for (number, traf) in trafs(&fragment.moof).into_iter().enumerate() {
                let Some(track) = tracks.iter_mut().find(|track| track.id == traf.id) else { continue };
                track.end = traf.base + traf.duration;
                if track.config.kind == TrackKind::Audio || traf.first_sync {
                    track.index.push((traf.base, fragment.at, u8::try_from(number + 1).unwrap_or(1)));
                }
                if track.config.kind == TrackKind::Video {
                    frames += u64::from(traf.count);
                }
            }
            Ok(())
        })?;
        file.set_len(complete)?;
        let mut out = BufWriter::with_capacity(1 << 20, file);
        out.seek(SeekFrom::Start(complete))?;
        Ok(Self {
            out,
            position: complete,
            tracks,
            sequence,
            duration_at,
            pending: None,
            expected: None,
            shift: 0.0,
            video_frames: frames,
            discontinuities: 0,
            resumed: true,
        })
    }

    /// Adds the fragments of another recording of the same tracks after this one's end, moved in
    /// time to follow on: two parts of a broadcast become one file. Its first `skip_ms` are left
    /// out (what both recorded twice). Returns how far, in milliseconds, the other recording's
    /// times moved, and how much of its start was left out.
    pub fn append(&mut self, path: &Path, skip_ms: i64) -> std::io::Result<(i64, i64)> {
        use std::os::unix::fs::FileExt;

        if let Some(pending) = self.pending.take() {
            self.write_fragment(pending)?;
        }
        let file = File::open(path)?;
        let length = file.metadata()?.len();
        let (head, first) = read_head(&file, length)?;
        let init = super::mp4read::parse_init(&head).map_err(|error| invalid(&error.0))?;
        // Their track ids, mapped to ours: the same tracks, configured the same, or nothing.
        let mut ids = Vec::new();
        for theirs in &init.tracks {
            let Some(mine) = self.tracks.iter().position(|track| same_track(&track.config, &theirs.config)) else {
                return Err(invalid("the recordings' tracks differ"));
            };
            ids.push((theirs.id, mine));
        }
        // Each of ours once: two of theirs on one track would mix them up.
        let mut taken: Vec<usize> = ids.iter().map(|(_, mine)| *mine).collect();
        taken.sort_unstable();
        taken.dedup();
        if ids.len() != self.tracks.len() || taken.len() != ids.len() {
            return Err(invalid("the recordings' tracks differ"));
        }
        let written_end = self
            .tracks
            .iter()
            .map(|track| track.end as f64 / f64::from(track.config.timescale))
            .reduce(f64::max)
            .unwrap_or(0.0);
        let mut origin: Option<f64> = None;
        let mut shift: Option<f64> = None;
        let mut skipped = 0.0;
        let mut copy = vec![0u8; 1 << 20];
        walk(&file, first, length, |mut fragment| {
            let infos = trafs(&fragment.moof);
            let mine = |id: u32| ids.iter().find(|(theirs, _)| *theirs == id).map(|(_, mine)| *mine);
            let start = infos
                .iter()
                .filter_map(|traf| {
                    let track = &self.tracks[mine(traf.id)?];
                    Some(traf.base as f64 / f64::from(track.config.timescale))
                })
                .reduce(f64::min)
                .unwrap_or(0.0);
            let origin = *origin.get_or_insert(start);
            if shift.is_none() && (start - origin) * 1000.0 < skip_ms as f64 {
                return Ok(());
            }
            let shift = *shift.get_or_insert_with(|| {
                skipped = start - origin;
                written_end - start
            });
            self.sequence += 1;
            if let Some(slot) = fragment.moof.get_mut(12..16) {
                slot.copy_from_slice(&self.sequence.to_be_bytes());
            }
            let at = self.position;
            for (number, traf) in infos.iter().enumerate() {
                let Some(index) = mine(traf.id) else { continue };
                let track = &mut self.tracks[index];
                // Their fragments name their track ids: renamed to ours, which the init describes.
                let Some(id_slot) = fragment.moof.get_mut(traf.id_at..traf.id_at + 4) else { continue };
                id_slot.copy_from_slice(&track.id.to_be_bytes());
                let base = (traf.base + timescaled(shift, track.config.timescale)).max(0);
                let Some(slot) = fragment.moof.get_mut(traf.time_at..traf.time_at + 8) else { continue };
                slot.copy_from_slice(&u64::try_from(base).unwrap_or(0).to_be_bytes());
                track.end = base + traf.duration;
                if track.config.kind == TrackKind::Audio || traf.first_sync {
                    track.index.push((base, at, u8::try_from(number + 1).unwrap_or(1)));
                }
                if track.config.kind == TrackKind::Video {
                    self.video_frames += u64::from(traf.count);
                }
            }
            let size = 8 + fragment.moof.len() as u64;
            self.out.write_all(&u32::try_from(size).map_err(|_| invalid("moof too large"))?.to_be_bytes())?;
            self.out.write_all(b"moof")?;
            self.out.write_all(&fragment.moof)?;
            let mut from = fragment.at + fragment.moof_header + fragment.moof.len() as u64;
            while from < fragment.end {
                let take = usize::try_from((fragment.end - from).min(copy.len() as u64)).unwrap_or(copy.len());
                file.read_exact_at(&mut copy[..take], from)?;
                self.out.write_all(&copy[..take])?;
                from += take as u64;
            }
            self.position += size + (fragment.end - fragment.at - fragment.moof_header - fragment.moof.len() as u64);
            Ok(())
        })?;
        self.out.flush()?;
        self.discontinuities += 1;
        self.expected = None;
        Ok(((shift.unwrap_or(0.0) * 1000.0).round() as i64, (skipped * 1000.0).round() as i64))
    }

    /// Whether a segment can go in this file: same tracks with the same configuration.
    pub fn accepts(&self, segment: &Segment) -> bool {
        let matches = |kind: TrackKind, data: &Option<TrackData>| match data {
            None => true,
            Some(data) => {
                self.tracks.iter().any(|track| track.config.kind == kind && same_track(&track.config, &data.config))
            }
        };
        matches(TrackKind::Video, &segment.video) && matches(TrackKind::Audio, &segment.audio)
    }

    /// Adds a segment. `discontinuity` forces a new timeline anchor, as after skipped ads.
    /// Returns where the segment starts in the output, in seconds, when the timeline was
    /// re-anchored: the recording maps wall-clock time to video time with these anchors.
    pub fn push(&mut self, segment: Segment, discontinuity: bool) -> std::io::Result<Option<f64>> {
        let parts: Vec<TrackData> =
            [segment.video, segment.audio].into_iter().flatten().filter(|track| !track.samples.is_empty()).collect();
        let Some(start) = parts.iter().filter_map(start_seconds).reduce(f64::min) else { return Ok(None) };
        let end = parts
            .iter()
            .filter_map(|track| {
                let last = track.samples.last()?;
                Some((last.dts + i64::from(last.duration)) as f64 / f64::from(track.config.timescale))
            })
            .reduce(f64::max)
            .unwrap_or(start);

        let jumped = match self.expected {
            None => true,
            Some(expected) => discontinuity || (start - expected).abs() > MAX_DRIFT,
        };
        if jumped {
            let written_end = self
                .tracks
                .iter()
                .map(|track| track.end as f64 / f64::from(track.config.timescale))
                .reduce(f64::max)
                .unwrap_or(0.0);
            if self.expected.is_some() || std::mem::take(&mut self.resumed) {
                self.discontinuities += 1;
            }
            self.shift = written_end - start;
            for track in &mut self.tracks {
                track.offset = timescaled(self.shift, track.config.timescale);
            }
        }
        self.expected = Some(end);

        let mut fragment = Fragment { tracks: Vec::new() };
        for part in parts {
            let Some(index) = self.tracks.iter().position(|track| track.config.kind == part.config.kind) else {
                continue;
            };
            let track = &mut self.tracks[index];
            let mut samples = part.samples;
            let mut previous = None::<i64>;
            for sample in &mut samples {
                sample.dts = (sample.dts + track.offset).max(0);
                // Decode times must grow, even across a sloppy source.
                if let Some(previous) = previous
                    && sample.dts <= previous
                {
                    sample.dts = previous + 1;
                }
                previous = Some(sample.dts);
            }
            fragment.tracks.push((index, samples));
        }

        // The pending fragment's last samples now know when the next ones start.
        if let Some(mut pending) = self.pending.take() {
            if !jumped {
                for (index, samples) in &mut pending.tracks {
                    let next = fragment.tracks.iter().find(|(other, _)| other == index).and_then(|(_, s)| s.first());
                    if let (Some(last), Some(next)) = (samples.last_mut(), next) {
                        let gap = next.dts - last.dts;
                        if gap > 0 && gap < i64::from(self.tracks[*index].config.timescale) * 10 {
                            last.duration = u32::try_from(gap).unwrap_or(last.duration);
                        }
                    }
                }
            }
            self.write_fragment(pending)?;
        }
        for (index, samples) in &fragment.tracks {
            if let Some(last) = samples.last() {
                self.tracks[*index].end = last.dts + i64::from(last.duration);
            }
        }
        self.pending = Some(fragment);
        Ok(jumped.then_some(start + self.shift))
    }

    fn write_fragment(&mut self, fragment: Fragment) -> std::io::Result<()> {
        self.sequence += 1;
        let moof_offset = self.position;
        // Built twice: the second time with the data offsets, which depend on the moof's size.
        let mut moof = self.moof(&fragment, 0);
        moof = self.moof(&fragment, moof.len());
        let payload: usize = fragment.tracks.iter().flat_map(|(_, samples)| samples).map(|s| s.data.len()).sum();
        let mut header = Vec::with_capacity(16);
        if payload + 8 <= u32::MAX as usize {
            header.extend_from_slice(&u32::try_from(payload + 8).unwrap_or(0).to_be_bytes());
            header.extend_from_slice(b"mdat");
        } else {
            header.extend_from_slice(&1u32.to_be_bytes());
            header.extend_from_slice(b"mdat");
            header.extend_from_slice(&(payload as u64 + 16).to_be_bytes());
        }
        self.out.write_all(&moof)?;
        self.out.write_all(&header)?;
        for (traf, (index, samples)) in fragment.tracks.iter().enumerate() {
            for sample in samples {
                self.out.write_all(&sample.data)?;
            }
            let track = &mut self.tracks[*index];
            if let Some(first) = samples.first()
                && (track.config.kind == TrackKind::Audio || first.keyframe)
            {
                track.index.push((first.dts, moof_offset, u8::try_from(traf + 1).unwrap_or(1)));
            }
            if track.config.kind == TrackKind::Video {
                self.video_frames += samples.len() as u64;
            }
        }
        self.position += (moof.len() + header.len() + payload) as u64;
        // Readers following the recording see whole fragments.
        self.out.flush()
    }

    fn moof(&self, fragment: &Fragment, moof_size: usize) -> Vec<u8> {
        let mut body = full_box(b"mfhd", 0, 0, &self.sequence.to_be_bytes());
        let mut data_offset = moof_size + 8;
        for (index, samples) in &fragment.tracks {
            let track = &self.tracks[*index];
            let mut traf = full_box(b"tfhd", 0, 0x02_0000, &track.id.to_be_bytes());
            let base = samples.first().map_or(0, |sample| sample.dts);
            traf.extend_from_slice(&full_box(b"tfdt", 1, 0, &u64::try_from(base).unwrap_or(0).to_be_bytes()));
            let mut run = Vec::with_capacity(8 + samples.len() * 16);
            run.extend_from_slice(&u32::try_from(samples.len()).unwrap_or(0).to_be_bytes());
            run.extend_from_slice(&i32::try_from(data_offset).unwrap_or(0).to_be_bytes());
            for sample in samples {
                run.extend_from_slice(&sample.duration.to_be_bytes());
                run.extend_from_slice(&u32::try_from(sample.data.len()).unwrap_or(0).to_be_bytes());
                let flags: u32 = if sample.keyframe { 0x0200_0000 } else { 0x0101_0000 };
                run.extend_from_slice(&flags.to_be_bytes());
                run.extend_from_slice(&sample.cts_offset.to_be_bytes());
                data_offset += sample.data.len();
            }
            traf.extend_from_slice(&full_box(b"trun", 1, 0x00_0F01, &run));
            body.extend_from_slice(&mp4_box(b"traf", &traf));
        }
        mp4_box(b"moof", &body)
    }

    pub fn progress(&self) -> Progress {
        let duration = self
            .tracks
            .iter()
            .map(|track| track.end as f64 / f64::from(track.config.timescale))
            .reduce(f64::max)
            .unwrap_or(0.0);
        let fps = if duration > 0.0 { self.video_frames as f64 / duration } else { 0.0 };
        Progress { duration_ms: (duration * 1000.0) as i64, bytes: self.position, fps }
    }

    /// Writes what is pending, the seek index and the duration, and syncs the file to disk.
    pub fn finish(mut self) -> std::io::Result<Progress> {
        if let Some(pending) = self.pending.take() {
            self.write_fragment(pending)?;
        }
        let entries: Vec<_> = self.tracks.iter().map(|track| (track.id, track.index.as_slice())).collect();
        let mfra = build_mfra(&entries);
        self.out.write_all(&mfra)?;
        self.position += mfra.len() as u64;

        let progress = self.progress();
        self.out.seek(SeekFrom::Start(self.duration_at))?;
        self.out.write_all(&u64::try_from(progress.duration_ms).unwrap_or(0).to_be_bytes())?;
        self.out.flush()?;
        self.out.get_ref().sync_all()?;
        Ok(progress)
    }
}

/// Makes a recording interrupted by a crash or power cut seekable: drops a torn last fragment,
/// then appends the index and duration a clean finish would have written.
///
/// Like [`Writer::resume`], it reads only box headers and `moof`s, never the media: a recording
/// of many hours is repaired without sitting in memory.
pub fn repair(path: &Path) -> std::io::Result<Progress> {
    let length = std::fs::metadata(path)?.len();
    if has_index(&File::open(path)?, length)? {
        return Ok(Progress { bytes: length, ..Progress::default() });
    }
    Writer::resume(path)?.finish()
}

/// Whether the file ends with an `mfra`, which its last box, `mfro`, gives the size of.
fn has_index(file: &File, length: u64) -> std::io::Result<bool> {
    use std::os::unix::fs::FileExt;

    let Some(size_at) = length.checked_sub(4) else { return Ok(false) };
    let mut size = [0u8; 4];
    file.read_exact_at(&mut size, size_at)?;
    let size = u64::from(u32::from_be_bytes(size));
    let Some(start) = length.checked_sub(size).filter(|_| size >= 16) else { return Ok(false) };
    let mut header = [0u8; 8];
    file.read_exact_at(&mut header, start)?;
    Ok(&header[4..] == b"mfra")
}

/// Whether samples of one track can go in a file made for the other: the same decoder setup.
/// The names and sizes people read are left out: a file read back may describe them otherwise.
fn same_track(a: &TrackConfig, b: &TrackConfig) -> bool {
    a.kind == b.kind && a.timescale == b.timescale && a.sample_entry == b.sample_entry
}

fn invalid(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message.to_owned())
}

/// A box's kind, size and header length at `position`, if it is whole within `length`.
fn box_at(file: &File, position: u64, length: u64) -> std::io::Result<Option<([u8; 4], u64, u64)>> {
    use std::os::unix::fs::FileExt;

    let mut header = [0u8; 16];
    if position.saturating_add(8) > length {
        return Ok(None);
    }
    file.read_exact_at(&mut header[..8], position)?;
    let mut size = u64::from(u32::from_be_bytes([header[0], header[1], header[2], header[3]]));
    let kind = [header[4], header[5], header[6], header[7]];
    let mut header_len = 8;
    if size == 1 {
        if position.saturating_add(16) > length {
            return Ok(None);
        }
        file.read_exact_at(&mut header[8..16], position + 8)?;
        size = u64::from_be_bytes(header[8..16].try_into().unwrap_or_default());
        header_len = 16;
    }
    // A size read from a damaged file may be anything: the sum must not wrap.
    let whole = position.checked_add(size).is_some_and(|end| end <= length);
    Ok((size >= header_len && whole).then_some((kind, size, header_len)))
}

/// The boxes before the first fragment (the init: `ftyp`, `moov`), and where the fragments start.
fn read_head(file: &File, length: u64) -> std::io::Result<(Vec<u8>, u64)> {
    use std::os::unix::fs::FileExt;

    let mut position = 0;
    while let Some((kind, size, _)) = box_at(file, position, length)? {
        if &kind == b"moof" {
            break;
        }
        position += size;
    }
    if position == 0 || position > 64 << 20 {
        return Err(invalid("no init segment"));
    }
    let mut head = vec![0u8; usize::try_from(position).unwrap_or(0)];
    file.read_exact_at(&mut head, 0)?;
    Ok((head, position))
}

/// A whole fragment of a file: where it starts, its `moof` body, where its `mdat` ends.
struct OnDisk {
    at: u64,
    moof_header: u64,
    moof: Vec<u8>,
    end: u64,
}

/// Reads the fragments from `from` on, up to an index, a torn box or `length`; returns where
/// the last whole fragment ends.
fn walk(
    file: &File,
    from: u64,
    length: u64,
    mut each: impl FnMut(OnDisk) -> std::io::Result<()>,
) -> std::io::Result<u64> {
    use std::os::unix::fs::FileExt;

    let mut position = from;
    let mut complete = from;
    let mut moof: Option<(u64, u64, Vec<u8>)> = None;
    while let Some((kind, size, header_len)) = box_at(file, position, length)? {
        match &kind {
            b"moof" => {
                let mut body = vec![0u8; usize::try_from(size - header_len).unwrap_or(0)];
                file.read_exact_at(&mut body, position + header_len)?;
                moof = Some((position, header_len, body));
            }
            b"mdat" => {
                if let Some((at, moof_header, body)) = moof.take() {
                    each(OnDisk { at, moof_header, moof: body, end: position + size })?;
                    complete = position + size;
                }
            }
            b"mfra" => break,
            _ => {}
        }
        position += size;
    }
    Ok(complete)
}

/// What a fragment holds of one track, read from its `traf`.
struct TrafInfo {
    id: u32,
    /// Where the track id is written in the `moof` body (the `tfhd`), to give it another.
    id_at: usize,
    /// Decode time of its first sample.
    base: i64,
    /// Where that time is written in the `moof` body (a version 1 `tfdt`), to move it.
    time_at: usize,
    duration: i64,
    count: u32,
    first_sync: bool,
}

/// The tracks of a fragment this writer wrote: version 1 `tfdt`, durations in the `trun`.
fn trafs(moof: &[u8]) -> Vec<TrafInfo> {
    use super::mp4read::boxes;

    let mut found = Vec::new();
    for (kind, traf, traf_at) in boxes(moof) {
        if &kind != b"traf" {
            continue;
        }
        let (mut id, mut id_at, mut base, mut time_at) = (None, 0, None, 0);
        let (mut duration, mut count, mut first_sync) = (0i64, 0, true);
        for (kind, body, at) in boxes(traf) {
            match &kind {
                b"tfhd" => {
                    id = body.get(4..8).map(|b| u32::from_be_bytes(b.try_into().unwrap_or_default()));
                    // Box header, traf header, tfhd header, version and flags.
                    id_at = traf_at + 8 + at + 8 + 4;
                }
                b"tfdt" if body.first() == Some(&1) => {
                    base = body.get(4..12).map(|b| u64::from_be_bytes(b.try_into().unwrap_or_default()));
                    time_at = traf_at + 8 + at + 8 + 4;
                }
                b"trun" => {
                    first_sync = first_sample_is_sync(body).unwrap_or(true);
                    let flags = u32::from_be_bytes(body.get(0..4).and_then(|b| b.try_into().ok()).unwrap_or_default())
                        & 0x00FF_FFFF;
                    count = u32::from_be_bytes(body.get(4..8).and_then(|b| b.try_into().ok()).unwrap_or_default());
                    let mut at = 8 + if flags & 0x01 != 0 { 4 } else { 0 } + if flags & 0x04 != 0 { 4 } else { 0 };
                    let per_sample = [0x100, 0x200, 0x400, 0x800].iter().filter(|bit| flags & **bit != 0).count() * 4;
                    if flags & 0x100 != 0 {
                        for _ in 0..count {
                            let Some(value) = body.get(at..at + 4) else { break };
                            duration += i64::from(u32::from_be_bytes(value.try_into().unwrap_or_default()));
                            at += per_sample;
                        }
                    }
                }
                _ => {}
            }
        }
        if let (Some(id), Some(base)) = (id, base) {
            found.push(TrafInfo {
                id,
                id_at,
                base: i64::try_from(base).unwrap_or(0),
                time_at,
                duration,
                count,
                first_sync,
            });
        }
    }
    found
}

/// The `mfra` box: per track, the time and place of each fragment a reader can start from.
fn build_mfra(tracks: &[(u32, &[IndexEntry])]) -> Vec<u8> {
    let mut mfra = Vec::new();
    for &(id, index) in tracks {
        let mut body = Vec::with_capacity(12 + index.len() * 19);
        body.extend_from_slice(&id.to_be_bytes());
        body.extend_from_slice(&0u32.to_be_bytes()); // one byte each for traf, trun and sample numbers
        body.extend_from_slice(&u32::try_from(index.len()).unwrap_or(0).to_be_bytes());
        for &(time, offset, traf) in index {
            body.extend_from_slice(&u64::try_from(time).unwrap_or(0).to_be_bytes());
            body.extend_from_slice(&offset.to_be_bytes());
            body.extend_from_slice(&[traf, 1, 1]);
        }
        mfra.extend_from_slice(&full_box(b"tfra", 1, 0, &body));
    }
    let mfro_size = 16u32;
    let total = u32::try_from(mfra.len() + 8 + mfro_size as usize).unwrap_or(0);
    mfra.extend_from_slice(&full_box(b"mfro", 0, 0, &total.to_be_bytes()));
    mp4_box(b"mfra", &mfra)
}

/// The seek index of a recording still being written, built from its fragments on disk.
///
/// A file being recorded has no `mfra` yet, so a player would have to walk every fragment to
/// seek in it. The media server serves the file cut after its last whole fragment, followed by
/// this index, which makes it a complete file to the player.
#[derive(Default)]
pub struct FragmentIndex {
    /// End of the last whole fragment read.
    pub complete: u64,
    tracks: Vec<(u32, Vec<IndexEntry>)>,
}

impl FragmentIndex {
    /// Reads the fragments written since the last call, up to `length` bytes of the file.
    pub fn extend(&mut self, file: &File, length: u64) -> std::io::Result<()> {
        use std::os::unix::fs::FileExt;

        let mut position = self.complete;
        let mut moof: Option<(u64, Vec<u8>)> = None;
        while let Some((kind, size, header_len)) = box_at(file, position, length)? {
            match &kind {
                b"moof" => {
                    let mut body = vec![0u8; usize::try_from(size - header_len).unwrap_or(0)];
                    file.read_exact_at(&mut body, position + header_len)?;
                    moof = Some((position, body));
                }
                b"mdat" => {
                    if let Some((offset, body)) = moof.take() {
                        self.add_fragment(offset, &body);
                    }
                    self.complete = position + size;
                }
                b"mfra" => break,
                _ => {
                    if moof.is_none() {
                        self.complete = position + size;
                    }
                }
            }
            position += size;
        }
        Ok(())
    }

    fn add_fragment(&mut self, offset: u64, moof: &[u8]) {
        use super::mp4read::boxes;

        let trafs = boxes(moof).filter(|(kind, _, _)| kind == b"traf");
        for (number, (_, traf, _)) in trafs.enumerate() {
            let mut id = None;
            let mut time = None;
            let mut keyframe = true;
            for (kind, body, _) in boxes(traf) {
                match &kind {
                    b"tfhd" => id = body.get(4..8).map(|b| u32::from_be_bytes(b.try_into().unwrap_or_default())),
                    b"tfdt" => {
                        time = if body.first() == Some(&1) {
                            body.get(4..12).map(|b| u64::from_be_bytes(b.try_into().unwrap_or_default()))
                        } else {
                            body.get(4..8).map(|b| u64::from(u32::from_be_bytes(b.try_into().unwrap_or_default())))
                        };
                    }
                    b"trun" => keyframe = first_sample_is_sync(body).unwrap_or(true),
                    _ => {}
                }
            }
            let (Some(id), Some(time)) = (id, time) else { continue };
            let slot = match self.tracks.iter().position(|(track, _)| *track == id) {
                Some(slot) => slot,
                None => {
                    self.tracks.push((id, Vec::new()));
                    self.tracks.len() - 1
                }
            };
            // Audio fragments always start cleanly; video ones only on a keyframe.
            if keyframe {
                let traf = u8::try_from(number + 1).unwrap_or(1);
                self.tracks[slot].1.push((i64::try_from(time).unwrap_or(0), offset, traf));
            }
        }
    }

    pub fn mfra(&self) -> Vec<u8> {
        let entries: Vec<_> = self.tracks.iter().map(|(id, index)| (*id, index.as_slice())).collect();
        build_mfra(&entries)
    }
}

/// Whether a `trun`'s first sample is a sync sample, from its flags (first-sample or per-sample).
fn first_sample_is_sync(trun: &[u8]) -> Option<bool> {
    let flags = u32::from_be_bytes(trun.get(0..4)?.try_into().ok()?) & 0x00FF_FFFF;
    let mut at = 8;
    if flags & 0x01 != 0 {
        at += 4;
    }
    let sample_flags = if flags & 0x04 != 0 {
        u32::from_be_bytes(trun.get(at..at + 4)?.try_into().ok()?)
    } else if flags & 0x400 != 0 {
        if flags & 0x100 != 0 {
            at += 4;
        }
        if flags & 0x200 != 0 {
            at += 4;
        }
        u32::from_be_bytes(trun.get(at..at + 4)?.try_into().ok()?)
    } else {
        // No flags here: the track's defaults apply, which a reader can't see from the fragment.
        return None;
    };
    Some(sample_flags & 0x0001_0000 == 0)
}

/// Where the duration field of `moov/mvex/mehd` (version 1) is in a file.
fn mehd_duration_offset(data: &[u8]) -> Option<u64> {
    use super::mp4read::boxes;

    let (_, moov, moov_at) = boxes(data).find(|(kind, _, _)| kind == b"moov")?;
    let (_, mvex, mvex_at) = boxes(moov).find(|(kind, _, _)| kind == b"mvex")?;
    let (_, mehd, mehd_at) = boxes(mvex).find(|(kind, _, _)| kind == b"mehd")?;
    (mehd.first() == Some(&1)).then_some((moov_at + 8 + mvex_at + 8 + mehd_at + 12) as u64)
}

fn init_segment(tracks: &[Track]) -> (Vec<u8>, u64) {
    let mut ftyp = Vec::new();
    ftyp.extend_from_slice(b"isom");
    ftyp.extend_from_slice(&0x200u32.to_be_bytes());
    for brand in [b"isom", b"iso6", b"mp41"] {
        ftyp.extend_from_slice(brand);
    }
    let ftyp = mp4_box(b"ftyp", &ftyp);

    let mut mvhd = Vec::with_capacity(96);
    mvhd.extend_from_slice(&[0; 8]); // creation and modification times
    mvhd.extend_from_slice(&MOVIE_TIMESCALE.to_be_bytes());
    mvhd.extend_from_slice(&0u32.to_be_bytes()); // duration: in mehd
    mvhd.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate
    mvhd.extend_from_slice(&0x0100u16.to_be_bytes()); // volume
    mvhd.extend_from_slice(&[0; 10]);
    for value in MATRIX {
        mvhd.extend_from_slice(&value.to_be_bytes());
    }
    mvhd.extend_from_slice(&[0; 24]);
    mvhd.extend_from_slice(&u32::try_from(tracks.len() + 1).unwrap_or(1).to_be_bytes());
    let mut moov = full_box(b"mvhd", 0, 0, &mvhd);

    for track in tracks {
        moov.extend_from_slice(&trak(track));
    }

    // mvex: mehd first, so its duration field sits at a known place.
    let mut mvex = Vec::new();
    let mehd = full_box(b"mehd", 1, 0, &0u64.to_be_bytes());
    let mehd_in_mvex = mvex.len();
    mvex.extend_from_slice(&mehd);
    for track in tracks {
        let mut trex = Vec::with_capacity(20);
        trex.extend_from_slice(&track.id.to_be_bytes());
        trex.extend_from_slice(&1u32.to_be_bytes());
        trex.extend_from_slice(&[0; 12]);
        mvex.extend_from_slice(&full_box(b"trex", 0, 0, &trex));
    }
    let mvex_in_moov = moov.len();
    moov.extend_from_slice(&mp4_box(b"mvex", &mvex));
    let moov = mp4_box(b"moov", &moov);

    // ftyp, moov header (8), position in moov, mvex header (8), position in mvex, mehd header (12).
    let duration_at = ftyp.len() + 8 + mvex_in_moov + 8 + mehd_in_mvex + 12;
    let mut out = ftyp;
    out.extend_from_slice(&moov);
    (out, duration_at as u64)
}

fn trak(track: &Track) -> Vec<u8> {
    let video = track.config.kind == TrackKind::Video;
    let mut tkhd = Vec::with_capacity(80);
    tkhd.extend_from_slice(&[0; 8]);
    tkhd.extend_from_slice(&track.id.to_be_bytes());
    tkhd.extend_from_slice(&[0; 4]);
    tkhd.extend_from_slice(&0u32.to_be_bytes()); // duration
    tkhd.extend_from_slice(&[0; 8]);
    tkhd.extend_from_slice(&0u16.to_be_bytes()); // layer
    tkhd.extend_from_slice(&0u16.to_be_bytes()); // alternate group
    tkhd.extend_from_slice(&(if video { 0u16 } else { 0x0100 }).to_be_bytes());
    tkhd.extend_from_slice(&[0; 2]);
    for value in MATRIX {
        tkhd.extend_from_slice(&value.to_be_bytes());
    }
    tkhd.extend_from_slice(&(track.config.width << 16).to_be_bytes());
    tkhd.extend_from_slice(&(track.config.height << 16).to_be_bytes());
    let tkhd = full_box(b"tkhd", 0, 0x3, &tkhd);

    let mut mdhd = Vec::with_capacity(20);
    mdhd.extend_from_slice(&[0; 8]);
    mdhd.extend_from_slice(&track.config.timescale.to_be_bytes());
    mdhd.extend_from_slice(&0u32.to_be_bytes());
    mdhd.extend_from_slice(&0x55C4u16.to_be_bytes()); // und
    mdhd.extend_from_slice(&[0; 2]);
    let mdhd = full_box(b"mdhd", 0, 0, &mdhd);

    let mut hdlr = vec![0; 4];
    hdlr.extend_from_slice(if video { b"vide" } else { b"soun" });
    hdlr.extend_from_slice(&[0; 12]);
    hdlr.extend_from_slice(if video { b"Video\0" } else { b"Audio\0" });
    let hdlr = full_box(b"hdlr", 0, 0, &hdlr);

    let header = if video { full_box(b"vmhd", 0, 1, &[0; 8]) } else { full_box(b"smhd", 0, 0, &[0; 4]) };
    let dref = full_box(b"dref", 0, 0, &[&1u32.to_be_bytes()[..], &full_box(b"url ", 0, 1, &[])].concat());
    let dinf = mp4_box(b"dinf", &dref);
    let mut stsd = 1u32.to_be_bytes().to_vec();
    stsd.extend_from_slice(&track.config.sample_entry);
    let mut stbl = full_box(b"stsd", 0, 0, &stsd);
    stbl.extend_from_slice(&full_box(b"stts", 0, 0, &0u32.to_be_bytes()));
    stbl.extend_from_slice(&full_box(b"stsc", 0, 0, &0u32.to_be_bytes()));
    stbl.extend_from_slice(&full_box(b"stsz", 0, 0, &[0; 8]));
    stbl.extend_from_slice(&full_box(b"stco", 0, 0, &0u32.to_be_bytes()));
    let minf = mp4_box(b"minf", &[header, dinf, mp4_box(b"stbl", &stbl)].concat());
    let mdia = mp4_box(b"mdia", &[mdhd, hdlr, minf].concat());
    mp4_box(b"trak", &[tkhd, mdia].concat())
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::super::mp4read;
    use super::*;

    fn track(kind: TrackKind, timescale: u32, entry: &[u8; 4], start: i64, step: u32, count: usize) -> TrackData {
        TrackData {
            config: TrackConfig {
                kind,
                timescale,
                sample_entry: mp4_box(entry, &[0; 28]),
                codec: "test",
                width: 0,
                height: 0,
                sample_rate: 0,
                channels: 0,
            },
            samples: (0..count)
                .map(|index| Sample {
                    dts: start + i64::try_from(index).unwrap_or(0) * i64::from(step),
                    cts_offset: 0,
                    duration: step,
                    keyframe: index == 0,
                    data: Bytes::from(vec![u8::try_from(index).unwrap_or(0); 10]),
                })
                .collect(),
        }
    }

    /// Segments written then read back keep their samples, and a jump in source time closes up.
    #[test]
    fn round_trips_and_closes_gaps() {
        let dir = std::env::temp_dir().join(format!("vixion-fmp4-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("out.mp4");
        let first = Segment {
            video: Some(track(TrackKind::Video, 90_000, b"avc1", 900_000, 3000, 60)),
            audio: Some(track(TrackKind::Audio, 48_000, b"mp4a", 480_000, 1024, 94)),
        };
        // Thirty seconds later in the source: an ad was cut.
        let second = Segment {
            video: Some(track(TrackKind::Video, 90_000, b"avc1", 900_000 + 180_000 + 2_700_000, 3000, 60)),
            audio: Some(track(TrackKind::Audio, 48_000, b"mp4a", 480_000 + 96_256 + 1_440_000, 1024, 94)),
        };
        let mut writer =
            Writer::create(&path, first.video.as_ref().map(|t| &t.config), first.audio.as_ref().map(|t| &t.config))
                .expect("create");
        writer.push(first, false).expect("first");
        writer.push(second, false).expect("second");
        assert_eq!(writer.discontinuities, 1);
        let progress = writer.finish().expect("finish");
        assert!((3_900..4_100).contains(&progress.duration_ms), "{}", progress.duration_ms);

        let file = std::fs::read(&path).expect("read back");
        let init = mp4read::parse_init(&file).expect("init");
        assert_eq!(init.tracks.len(), 2);
        let segment = mp4read::demux(&file, &init).expect("demux");
        let video = segment.video.expect("video");
        assert_eq!(video.samples.len(), 120);
        assert_eq!(video.samples[0].dts, 0);
        // The second segment follows the first one's end (audio ends 5 ms after the picture).
        assert!((180_000..=181_000).contains(&video.samples[60].dts), "{}", video.samples[60].dts);
        assert!(boxes_contain(&file, b"mfra"));

        // The index rebuilt from the fragments, as for a recording still running, is the one written.
        let (_, written, mfra_at) = mp4read::boxes(&file).find(|(k, _, _)| k == b"mfra").expect("mfra");
        let mut index = FragmentIndex::default();
        index.extend(&std::fs::File::open(&path).expect("open"), mfra_at as u64).expect("index");
        assert_eq!(index.complete, mfra_at as u64);
        assert_eq!(&index.mfra()[8..], written);

        // A file cut in the middle of its last fragment is repaired up to the fragment before.
        let without_index =
            file.len() - mp4read::boxes(&file).find(|(k, _, _)| k == b"mfra").map_or(0, |(_, b, _)| b.len() + 8);
        std::fs::write(&path, &file[..without_index - 100]).expect("truncate");
        let repaired = repair(&path).expect("repair");
        assert!((1_900..2_100).contains(&repaired.duration_ms), "{}", repaired.duration_ms);
        // A file with its index is left as it is.
        let length = std::fs::metadata(&path).expect("metadata").len();
        assert_eq!(repair(&path).expect("again").bytes, length);
        assert_eq!(std::fs::metadata(&path).expect("metadata").len(), length);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn segment(video_start: i64, audio_start: i64) -> Segment {
        Segment {
            video: Some(track(TrackKind::Video, 90_000, b"avc1", video_start, 3000, 60)),
            audio: Some(track(TrackKind::Audio, 48_000, b"mp4a", audio_start, 1024, 94)),
        }
    }

    fn create(path: &Path, first: &Segment) -> Writer {
        Writer::create(path, first.video.as_ref().map(|t| &t.config), first.audio.as_ref().map(|t| &t.config))
            .expect("create")
    }

    /// A recording stopped then reopened goes on in the same file, after a cut.
    #[test]
    fn resumes_a_finished_recording() {
        let dir = std::env::temp_dir().join(format!("vixion-resume-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("out.mp4");
        let mut writer = create(&path, &segment(0, 0));
        writer.push(segment(0, 0), false).expect("first");
        writer.finish().expect("finish");

        let mut writer = Writer::resume(&path).expect("resume");
        // A new session: the source clock is anywhere.
        let later = segment(54_000_000, 28_800_000);
        assert!(writer.accepts(&later));
        let anchor = writer.push(later, false).expect("push").expect("a new anchor");
        assert!((1.9..2.1).contains(&anchor), "{anchor}");
        assert_eq!(writer.discontinuities, 1);
        let progress = writer.finish().expect("finish");
        assert!((3_900..4_100).contains(&progress.duration_ms), "{}", progress.duration_ms);

        let file = std::fs::read(&path).expect("read back");
        assert_eq!(mp4read::boxes(&file).filter(|(k, _, _)| k == b"mfra").count(), 1);
        let init = mp4read::parse_init(&file).expect("init");
        let video = mp4read::demux(&file, &init).expect("demux").video.expect("video");
        assert_eq!(video.samples.len(), 120);
        assert!((180_000..=181_000).contains(&video.samples[60].dts), "{}", video.samples[60].dts);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Two parts of a broadcast become one file, the second following the first.
    #[test]
    fn appends_another_recording() {
        let dir = std::env::temp_dir().join(format!("vixion-append-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let (one, two) = (dir.join("one.mp4"), dir.join("two.mp4"));
        let mut writer = create(&one, &segment(0, 0));
        writer.push(segment(0, 0), false).expect("one");
        writer.finish().expect("finish one");
        let mut writer = create(&two, &segment(0, 0));
        writer.push(segment(0, 0), false).expect("two");
        writer.push(segment(180_000, 96_256), false).expect("two more");
        writer.finish().expect("finish two");

        let mut writer = Writer::resume(&one).expect("resume");
        let (shift, skipped) = writer.append(&two, 0).expect("append");
        assert!((1_990..2_010).contains(&shift), "{shift}");
        assert_eq!(skipped, 0);
        let progress = writer.finish().expect("finish");
        assert!((5_900..6_100).contains(&progress.duration_ms), "{}", progress.duration_ms);

        let file = std::fs::read(&one).expect("read back");
        let init = mp4read::parse_init(&file).expect("init");
        let segment = mp4read::demux(&file, &init).expect("demux");
        let video = segment.video.expect("video");
        assert_eq!(video.samples.len(), 180);
        assert!(video.samples.windows(2).all(|pair| pair[1].dts > pair[0].dts));
        // The index a player seeks with covers every fragment, the appended ones included.
        let mut index = FragmentIndex::default();
        let (_, _, mfra_at) = mp4read::boxes(&file).find(|(k, _, _)| k == b"mfra").expect("mfra");
        index.extend(&std::fs::File::open(&one).expect("open"), mfra_at as u64).expect("index");
        assert_eq!(index.complete, mfra_at as u64);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn boxes_contain(data: &[u8], kind: &[u8; 4]) -> bool {
        mp4read::boxes(data).any(|(found, _, _)| &found == kind)
    }
}
