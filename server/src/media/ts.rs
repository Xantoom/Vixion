//! MPEG-TS demuxing for Twitch's H.264 + AAC segments.
//!
//! Each Twitch segment is self-contained (tables, then a keyframe with its parameter sets), so
//! a segment is demuxed on its own. A segment missing its parameter sets reuses the previous
//! track's configuration.

use std::collections::HashMap;

use bytes::{BufMut, Bytes, BytesMut};

use super::{MediaError, Sample, Segment, TrackConfig, TrackData, TrackKind, aac, err, h264};

const PACKET: usize = 188;
const STREAM_AAC: u8 = 0x0F;
const STREAM_H264: u8 = 0x1B;
/// MPEG-TS clock.
const TS_CLOCK: u32 = 90_000;

struct Pes {
    pts: Option<i64>,
    dts: Option<i64>,
    data: Vec<u8>,
}

fn timestamp(bytes: &[u8]) -> i64 {
    (i64::from(bytes[0] & 0x0E) << 29)
        | (i64::from(bytes[1]) << 22)
        | (i64::from(bytes[2] & 0xFE) << 14)
        | (i64::from(bytes[3]) << 7)
        | (i64::from(bytes[4]) >> 1)
}

fn parse_pes(data: &[u8]) -> Option<Pes> {
    if data.len() < 9 || data[0..3] != [0, 0, 1] {
        return None;
    }
    let flags = data[7];
    let header_len = usize::from(data[8]);
    let payload = data.get(9 + header_len..)?;
    let pts = (flags & 0x80 != 0).then(|| data.get(9..14).map(timestamp)).flatten();
    let dts = (flags & 0x40 != 0).then(|| data.get(14..19).map(timestamp)).flatten();
    Some(Pes { pts, dts, data: payload.to_vec() })
}

/// Section payload of a PSI packet (PAT or PMT), pointer field skipped.
fn section(payload: &[u8]) -> Option<&[u8]> {
    let pointer = usize::from(*payload.first()?);
    let table = payload.get(1 + pointer..)?;
    let length = ((usize::from(*table.get(1)?) & 0x0F) << 8) | usize::from(*table.get(2)?);
    table.get(..(3 + length).min(table.len()))
}

/// Demuxes one segment. `previous` supplies track configurations when a segment lacks them.
pub fn demux(data: &[u8], previous: &Segment) -> Result<Segment, MediaError> {
    let mut pmt_pid = None;
    let mut streams: HashMap<u16, u8> = HashMap::new();
    let mut assembling: HashMap<u16, Vec<u8>> = HashMap::new();
    let mut finished: Vec<(u8, Vec<u8>)> = Vec::new();

    let start = data.iter().position(|&byte| byte == 0x47).unwrap_or(0);
    for packet in data[start..].as_chunks::<PACKET>().0 {
        if packet[0] != 0x47 {
            continue;
        }
        let unit_start = packet[1] & 0x40 != 0;
        let pid = (u16::from(packet[1] & 0x1F) << 8) | u16::from(packet[2]);
        let adaptation = (packet[3] >> 4) & 3;
        let mut offset = 4;
        if adaptation & 2 != 0 {
            offset += 1 + usize::from(packet[4]);
        }
        if adaptation & 1 == 0 || offset >= PACKET {
            continue;
        }
        let payload = &packet[offset..];

        if pid == 0 && unit_start {
            if let Some(table) = section(payload) {
                // Program entries start after the 8-byte header and stop before the CRC.
                let programs = table.get(8..table.len().saturating_sub(4)).unwrap_or_default();
                pmt_pid = programs
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .find(|entry| u16::from_be_bytes([entry[0], entry[1]]) != 0)
                    .map(|entry| (u16::from(entry[2] & 0x1F) << 8) | u16::from(entry[3]));
            }
        } else if Some(pid) == pmt_pid && unit_start {
            if let Some(table) = section(payload) {
                let info_len = ((usize::from(*table.get(10).unwrap_or(&0)) & 0x0F) << 8)
                    | usize::from(*table.get(11).unwrap_or(&0));
                let mut entries = table.get(12 + info_len..table.len().saturating_sub(4)).unwrap_or_default();
                while entries.len() >= 5 {
                    let stream_type = entries[0];
                    let es_pid = (u16::from(entries[1] & 0x1F) << 8) | u16::from(entries[2]);
                    let es_info = ((usize::from(entries[3]) & 0x0F) << 8) | usize::from(entries[4]);
                    if matches!(stream_type, STREAM_H264 | STREAM_AAC) {
                        streams.insert(es_pid, stream_type);
                    }
                    entries = entries.get(5 + es_info..).unwrap_or_default();
                }
            }
        } else if let Some(&stream_type) = streams.get(&pid) {
            if unit_start && let Some(done) = assembling.remove(&pid) {
                finished.push((stream_type, done));
            }
            if unit_start || assembling.contains_key(&pid) {
                assembling.entry(pid).or_default().extend_from_slice(payload);
            }
        }
    }
    for (pid, rest) in assembling {
        if let Some(&stream_type) = streams.get(&pid) {
            finished.push((stream_type, rest));
        }
    }

    let mut video = VideoBuilder::default();
    let mut audio = AudioBuilder::default();
    for (stream_type, raw) in finished {
        let Some(pes) = parse_pes(&raw) else { continue };
        match stream_type {
            STREAM_H264 => video.push(pes),
            STREAM_AAC => audio.push(pes),
            _ => {}
        }
    }
    Ok(Segment { video: video.finish(previous.video.as_ref())?, audio: audio.finish(previous.audio.as_ref()) })
}

#[derive(Default)]
struct VideoBuilder {
    sps: Option<Vec<u8>>,
    pps: Vec<Vec<u8>>,
    /// Access units in Annex B, as they came, until the segment is complete.
    units: Vec<Pes>,
    samples: Vec<Sample>,
}

impl VideoBuilder {
    fn push(&mut self, mut pes: Pes) {
        // Twitch's encoder sometimes starts a PES with the end of the previous picture's last
        // NAL unit, before any start code. It belongs to that picture: dropping it cuts off the
        // bottom of the frame.
        let first = h264::find_start_code(&pes.data).unwrap_or(pes.data.len());
        let mut lead = first;
        while lead > 0 && pes.data[lead - 1] == 0 {
            lead -= 1;
        }
        if lead > 0
            && let Some(previous) = self.units.last_mut()
        {
            previous.data.extend_from_slice(&pes.data[..lead]);
        }
        pes.data.drain(..first);
        if pes.pts.is_some() {
            self.units.push(pes);
        }
    }

    fn convert(&mut self, pes: Pes) {
        let Some(pts) = pes.pts else { return };
        let dts = pes.dts.unwrap_or(pts);
        let mut keyframe = false;
        let mut out = BytesMut::with_capacity(pes.data.len() + 16);
        for nal in h264::split_annex_b(&pes.data) {
            let Some(&header) = nal.first() else { continue };
            match header & 0x1F {
                h264::NAL_AUD => continue,
                h264::NAL_SPS => {
                    if self.sps.is_none() {
                        self.sps = Some(nal.to_vec());
                    }
                }
                h264::NAL_PPS => {
                    if !self.pps.iter().any(|known| known == nal) {
                        self.pps.push(nal.to_vec());
                    }
                }
                h264::NAL_IDR => keyframe = true,
                _ => {}
            }
            out.put_u32(u32::try_from(nal.len()).unwrap_or(0));
            out.put_slice(nal);
        }
        if out.is_empty() {
            return;
        }
        self.samples.push(Sample {
            dts,
            cts_offset: i32::try_from(pts - dts).unwrap_or(0),
            duration: 0,
            keyframe,
            data: out.freeze(),
        });
    }

    fn finish(mut self, previous: Option<&TrackData>) -> Result<Option<TrackData>, MediaError> {
        for unit in std::mem::take(&mut self.units) {
            self.convert(unit);
        }
        if self.samples.is_empty() {
            return Ok(None);
        }
        self.samples.sort_by_key(|sample| sample.dts);
        fill_durations(&mut self.samples, 0);
        let config = match (&self.sps, previous) {
            (Some(sps), _) if !self.pps.is_empty() => {
                let (sample_entry, info) = h264::sample_entry(sps, &self.pps)?;
                TrackConfig {
                    kind: TrackKind::Video,
                    timescale: TS_CLOCK,
                    sample_entry,
                    codec: "h264",
                    width: info.width,
                    height: info.height,
                    sample_rate: 0,
                    channels: 0,
                }
            }
            (_, Some(previous)) => previous.config.clone(),
            _ => return err("H.264 segment without parameter sets"),
        };
        Ok(Some(TrackData { config, samples: self.samples }))
    }
}

#[derive(Default)]
struct AudioBuilder {
    header: Option<aac::AdtsHeader>,
    samples: Vec<Sample>,
}

impl AudioBuilder {
    fn push(&mut self, pes: Pes) {
        let Some(pts) = pes.pts else { return };
        let mut rest = pes.data.as_slice();
        let mut index = 0i64;
        while let Some(header) = aac::parse_adts(rest) {
            let Some(frame) = rest.get(header.header_len..header.frame_len) else { break };
            let rate = header.sample_rate();
            self.header.get_or_insert(header);
            // PTS in 90 kHz, converted to the track's own clock: the sample rate.
            let dts = pts * i64::from(rate) / i64::from(TS_CLOCK) + index * i64::from(aac::FRAME_SAMPLES);
            self.samples.push(Sample {
                dts,
                cts_offset: 0,
                duration: aac::FRAME_SAMPLES,
                keyframe: true,
                data: Bytes::copy_from_slice(frame),
            });
            rest = &rest[header.frame_len..];
            index += 1;
        }
    }

    fn finish(mut self, previous: Option<&TrackData>) -> Option<TrackData> {
        if self.samples.is_empty() {
            return None;
        }
        self.samples.sort_by_key(|sample| sample.dts);
        let config = match (self.header, previous) {
            (Some(header), _) => TrackConfig {
                kind: TrackKind::Audio,
                timescale: header.sample_rate(),
                sample_entry: aac::sample_entry(&header),
                codec: "aac",
                width: 0,
                height: 0,
                sample_rate: header.sample_rate(),
                channels: u16::from(header.channels),
            },
            (None, Some(previous)) => previous.config.clone(),
            (None, None) => return None,
        };
        Some(TrackData { config, samples: self.samples })
    }
}

/// Sets each sample's duration from the next one's decode time; the last copies the one before.
pub(crate) fn fill_durations(samples: &mut [Sample], fallback: u32) {
    for index in 0..samples.len() {
        if let Some(next) = samples.get(index + 1).map(|next| next.dts) {
            samples[index].duration = u32::try_from(next - samples[index].dts).unwrap_or(0);
        }
    }
    if let Some(last) = samples.len().checked_sub(1) {
        samples[last].duration =
            if last > 0 { samples[last - 1].duration } else { fallback.max(samples[last].duration) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_picture_tail_carried_into_the_next_pes() {
        let pes = |pts, data: &[u8]| Pes { pts: Some(pts), dts: None, data: data.to_vec() };
        let mut video = VideoBuilder::default();
        // A non-IDR slice whose last bytes arrive at the start of the next PES.
        video.push(pes(0, &[0, 0, 0, 1, 0x41, 0xAA, 0xBB]));
        video.push(pes(3000, &[0xCC, 0xDD, 0, 0, 0, 1, 0x41, 0xEE]));
        for unit in std::mem::take(&mut video.units) {
            video.convert(unit);
        }
        let first: &[u8] = &video.samples[0].data;
        assert_eq!(first, [0, 0, 0, 5, 0x41, 0xAA, 0xBB, 0xCC, 0xDD]);
        let second: &[u8] = &video.samples[1].data;
        assert_eq!(second, [0, 0, 0, 2, 0x41, 0xEE]);
    }

    /// Real Twitch segments, when `VIXION_TS_SAMPLES` names a folder of `.ts` files.
    #[test]
    fn demuxes_twitch_samples() {
        let Ok(dir) = std::env::var("VIXION_TS_SAMPLES") else { return };
        let mut files: Vec<_> = std::fs::read_dir(dir).expect("folder").flatten().map(|e| e.path()).collect();
        files.sort();
        let mut previous = Segment::default();
        for file in files {
            let data = std::fs::read(&file).expect("read");
            let segment = demux(&data, &previous).expect("demux");
            let video = segment.video.as_ref().expect("video");
            let audio = segment.audio.as_ref().expect("audio");
            assert!(video.samples[0].keyframe);
            eprintln!(
                "{}: {}x{} {} frames, {} audio frames at {} Hz, starts {:.3}s",
                file.display(),
                video.config.width,
                video.config.height,
                video.samples.len(),
                audio.samples.len(),
                audio.config.sample_rate,
                video.samples[0].dts as f64 / 90_000.0
            );
            previous = segment;
        }
    }
}
