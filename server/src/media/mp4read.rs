//! Fragmented MP4 demuxing, for Twitch's HEVC and AV1 segments.
//!
//! The init segment gives each track's sample entry, copied as is into the recording, so any
//! codec Twitch adds later records without code changes. Media segments are `moof` + `mdat`
//! pairs; their samples are read from the `trun` tables.

use bytes::Bytes;

use super::{MediaError, Sample, Segment, TrackConfig, TrackData, TrackKind, err};

/// Iterates over the boxes in `data`: (type, body, offset of the box in `data`).
pub struct Boxes<'a> {
    data: &'a [u8],
    position: usize,
}

pub fn boxes(data: &[u8]) -> Boxes<'_> {
    Boxes { data, position: 0 }
}

impl<'a> Iterator for Boxes<'a> {
    type Item = ([u8; 4], &'a [u8], usize);

    fn next(&mut self) -> Option<Self::Item> {
        let start = self.position;
        let header = self.data.get(start..start + 8)?;
        let mut size = u64::from(u32::from_be_bytes([header[0], header[1], header[2], header[3]]));
        let kind = [header[4], header[5], header[6], header[7]];
        let mut body_start = start + 8;
        if size == 1 {
            let large = self.data.get(start + 8..start + 16)?;
            size = u64::from_be_bytes(large.try_into().ok()?);
            body_start += 8;
        } else if size == 0 {
            size = (self.data.len() - start) as u64;
        }
        let end = start.checked_add(usize::try_from(size).ok()?)?;
        if size < 8 || end > self.data.len() {
            return None;
        }
        self.position = end;
        Some((kind, &self.data[body_start..end], start))
    }
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).find(|(found, _, _)| found == kind).map(|(_, body, _)| body)
}

fn be_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

fn be_u64(data: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(data.get(at..at + 8)?.try_into().ok()?))
}

fn be_u16(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

/// A track of the init segment, with the defaults its fragments may rely on.
#[derive(Debug, Clone)]
pub struct InitTrack {
    pub id: u32,
    pub config: TrackConfig,
    default_duration: u32,
    default_size: u32,
    default_flags: u32,
}

#[derive(Debug, Clone, Default)]
pub struct Init {
    pub tracks: Vec<InitTrack>,
}

fn codec_of(entry_type: &[u8; 4]) -> &'static str {
    match entry_type {
        b"avc1" | b"avc3" => "h264",
        b"hvc1" | b"hev1" => "hevc",
        b"av01" => "av1",
        b"mp4a" => "aac",
        b"Opus" => "opus",
        b"ac-3" => "ac3",
        b"ec-3" => "eac3",
        _ => "unknown",
    }
}

pub fn parse_init(data: &[u8]) -> Result<Init, MediaError> {
    let Some(moov) = child(data, b"moov") else { return err("init segment without moov") };
    let mut tracks = Vec::new();
    for (kind, trak, _) in boxes(moov) {
        if &kind != b"trak" {
            continue;
        }
        let Some(track) = parse_trak(trak) else { continue };
        tracks.push(track);
    }
    if let Some(mvex) = child(moov, b"mvex") {
        for (kind, trex, _) in boxes(mvex) {
            if &kind != b"trex" {
                continue;
            }
            let id = be_u32(trex, 4).unwrap_or(0);
            if let Some(track) = tracks.iter_mut().find(|track| track.id == id) {
                track.default_duration = be_u32(trex, 12).unwrap_or(0);
                track.default_size = be_u32(trex, 16).unwrap_or(0);
                track.default_flags = be_u32(trex, 20).unwrap_or(0);
            }
        }
    }
    if tracks.is_empty() {
        return err("init segment without audio or video track");
    }
    Ok(Init { tracks })
}

fn parse_trak(trak: &[u8]) -> Option<InitTrack> {
    let tkhd = child(trak, b"tkhd")?;
    let id = if tkhd[0] == 1 { be_u32(tkhd, 20)? } else { be_u32(tkhd, 12)? };
    let mdia = child(trak, b"mdia")?;
    let mdhd = child(mdia, b"mdhd")?;
    let timescale = if mdhd[0] == 1 { be_u32(mdhd, 20)? } else { be_u32(mdhd, 12)? };
    let handler = child(mdia, b"hdlr")?.get(8..12)?;
    let kind = match handler {
        b"vide" => TrackKind::Video,
        b"soun" => TrackKind::Audio,
        _ => return None,
    };
    let stsd = child(child(child(mdia, b"minf")?, b"stbl")?, b"stsd")?;
    // stsd: version and flags, entry count, then the entries; the first one is used.
    let entries = stsd.get(8..)?;
    let (entry_type, _, _) = boxes(entries).next()?;
    let entry_size = usize::try_from(be_u32(entries, 0)?).ok()?;
    let mut sample_entry = entries.get(..entry_size)?.to_vec();
    prefer_hvc1(&mut sample_entry);
    let mut config = TrackConfig {
        kind,
        timescale,
        codec: codec_of(&entry_type),
        width: 0,
        height: 0,
        sample_rate: 0,
        channels: 0,
        sample_entry,
    };
    match kind {
        TrackKind::Video => {
            config.width = u32::from(be_u16(&config.sample_entry, 32)?);
            config.height = u32::from(be_u16(&config.sample_entry, 34)?);
        }
        TrackKind::Audio => {
            config.channels = be_u16(&config.sample_entry, 24)?;
            config.sample_rate = be_u32(&config.sample_entry, 32)? >> 16;
        }
    }
    Some(InitTrack { id, config, default_duration: 0, default_size: 0, default_flags: 0 })
}

/// Relabels an `hev1` entry as `hvc1` when its `hvcC` carries the VPS, SPS and PPS.
///
/// Twitch sends `hev1`, which Apple's players refuse. `hvc1` only promises that the parameter
/// sets are in the sample entry; copies repeated in the stream are allowed and harmless.
fn prefer_hvc1(entry: &mut [u8]) {
    // A visual sample entry: 8-byte header, 78 bytes of fields, then child boxes.
    if entry.get(4..8) != Some(b"hev1".as_slice()) {
        return;
    }
    let Some(hvcc) = entry.get(86..).and_then(|children| child(children, b"hvcC")) else { return };
    let mut found = [false; 3];
    let Some(&arrays) = hvcc.get(22) else { return };
    let mut at = 23;
    for _ in 0..arrays {
        let (Some(&kind), Some(count)) = (hvcc.get(at), be_u16(hvcc, at + 1)) else { return };
        if let Some(slot) = (kind & 0x3F).checked_sub(32).and_then(|index| found.get_mut(usize::from(index))) {
            *slot = count > 0;
        }
        at += 3;
        for _ in 0..count {
            let Some(length) = be_u16(hvcc, at) else { return };
            at += 2 + usize::from(length);
        }
    }
    if found.iter().all(|&present| present) {
        entry[4..8].copy_from_slice(b"hvc1");
    }
}

const SAMPLE_NON_SYNC: u32 = 0x0001_0000;

/// Demuxes a media segment (one or more `moof` + `mdat`) with the tracks of its init segment.
pub fn demux(data: &[u8], init: &Init) -> Result<Segment, MediaError> {
    let mut segment = Segment::default();
    for (kind, moof, moof_offset) in boxes(data) {
        if &kind != b"moof" {
            continue;
        }
        for (kind, traf, _) in boxes(moof) {
            if &kind != b"traf" {
                continue;
            }
            read_traf(data, moof_offset, traf, init, &mut segment)?;
        }
    }
    Ok(segment)
}

fn read_traf(
    data: &[u8],
    moof_offset: usize,
    traf: &[u8],
    init: &Init,
    segment: &mut Segment,
) -> Result<(), MediaError> {
    let Some(tfhd) = child(traf, b"tfhd") else { return err("traf without tfhd") };
    let flags = be_u32(tfhd, 0).unwrap_or(0) & 0x00FF_FFFF;
    let id = be_u32(tfhd, 4).unwrap_or(0);
    let Some(track) = init.tracks.iter().find(|track| track.id == id) else { return Ok(()) };
    let mut at = 8;
    let mut base = moof_offset as u64;
    if flags & 0x1 != 0 {
        base = be_u64(tfhd, at).unwrap_or(base);
        at += 8;
    }
    if flags & 0x2 != 0 {
        at += 4;
    }
    let mut default_duration = track.default_duration;
    let mut default_size = track.default_size;
    let mut default_flags = track.default_flags;
    if flags & 0x8 != 0 {
        default_duration = be_u32(tfhd, at).unwrap_or(default_duration);
        at += 4;
    }
    if flags & 0x10 != 0 {
        default_size = be_u32(tfhd, at).unwrap_or(default_size);
        at += 4;
    }
    if flags & 0x20 != 0 {
        default_flags = be_u32(tfhd, at).unwrap_or(default_flags);
    }

    let mut dts = child(traf, b"tfdt")
        .and_then(|tfdt| if tfdt[0] == 1 { be_u64(tfdt, 4) } else { be_u32(tfdt, 4).map(u64::from) })
        .map_or(0, |time| i64::try_from(time).unwrap_or(0));

    let target = match track.config.kind {
        TrackKind::Video => &mut segment.video,
        TrackKind::Audio => &mut segment.audio,
    };
    let track_data = target.get_or_insert_with(|| TrackData { config: track.config.clone(), samples: Vec::new() });

    for (kind, trun, _) in boxes(traf) {
        if &kind != b"trun" {
            continue;
        }
        let version = trun[0];
        let run_flags = be_u32(trun, 0).unwrap_or(0) & 0x00FF_FFFF;
        let count = be_u32(trun, 4).unwrap_or(0);
        let mut at = 8;
        let mut offset = base;
        if run_flags & 0x1 != 0 {
            let relative = i64::from(be_u32(trun, at).unwrap_or(0).cast_signed());
            offset = offset.wrapping_add_signed(relative);
            at += 4;
        }
        let mut first_flags = None;
        if run_flags & 0x4 != 0 {
            first_flags = be_u32(trun, at);
            at += 4;
        }
        for index in 0..count {
            let mut read = |present: u32| -> Option<u32> {
                if run_flags & present == 0 {
                    return None;
                }
                let value = be_u32(trun, at);
                at += 4;
                value
            };
            let duration = read(0x100).unwrap_or(default_duration);
            let size = read(0x200).unwrap_or(default_size);
            let sample_flags = read(0x400).or(if index == 0 { first_flags } else { None }).unwrap_or(default_flags);
            let cts_offset = read(0x800)
                .map_or(0, |raw| if version == 0 { i32::try_from(raw).unwrap_or(0) } else { raw.cast_signed() });

            let start = usize::try_from(offset).unwrap_or(usize::MAX);
            let end = start.saturating_add(size as usize);
            let Some(bytes) = data.get(start..end) else { return err("sample outside the segment") };
            track_data.samples.push(Sample {
                dts,
                cts_offset,
                duration,
                keyframe: track.config.kind == TrackKind::Audio || sample_flags & SAMPLE_NON_SYNC == 0,
                data: Bytes::copy_from_slice(bytes),
            });
            dts += i64::from(duration);
            offset += u64::from(size);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hev1_entry(nal_types: &[u8]) -> Vec<u8> {
        let mut hvcc = vec![0u8; 22];
        hvcc.push(u8::try_from(nal_types.len()).expect("few arrays"));
        for &kind in nal_types {
            hvcc.extend_from_slice(&[0x80 | kind, 0, 1, 0, 2, 0x40, 0x01]);
        }
        let hvcc_box = crate::media::mp4_box(b"hvcC", &hvcc);
        let mut body = vec![0u8; 78];
        body.extend_from_slice(&hvcc_box);
        crate::media::mp4_box(b"hev1", &body)
    }

    #[test]
    fn relabels_hev1_with_parameter_sets_as_hvc1() {
        let mut complete = hev1_entry(&[32, 33, 34]);
        prefer_hvc1(&mut complete);
        assert_eq!(&complete[4..8], b"hvc1");

        let mut missing_vps = hev1_entry(&[33, 34]);
        prefer_hvc1(&mut missing_vps);
        assert_eq!(&missing_vps[4..8], b"hev1");
    }
}
