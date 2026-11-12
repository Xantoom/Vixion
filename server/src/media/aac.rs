//! AAC: ADTS frames from MPEG-TS, and the `mp4a` sample entry.

use super::{full_box, mp4_box};

const SAMPLE_RATES: [u32; 13] =
    [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/// Samples per AAC frame.
pub const FRAME_SAMPLES: u32 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdtsHeader {
    /// Audio object type: 2 for AAC-LC.
    pub object_type: u8,
    pub rate_index: u8,
    pub channels: u8,
    pub header_len: usize,
    pub frame_len: usize,
}

impl AdtsHeader {
    pub fn sample_rate(&self) -> u32 {
        SAMPLE_RATES.get(usize::from(self.rate_index)).copied().unwrap_or(48000)
    }
}

pub fn parse_adts(data: &[u8]) -> Option<AdtsHeader> {
    if data.len() < 7 || data[0] != 0xFF || data[1] & 0xF6 != 0xF0 {
        return None;
    }
    let protection_absent = data[1] & 1 == 1;
    let object_type = ((data[2] >> 6) & 3) + 1;
    let rate_index = (data[2] >> 2) & 0xF;
    let channels = ((data[2] & 1) << 2) | (data[3] >> 6);
    let frame_len = (usize::from(data[3] & 3) << 11) | (usize::from(data[4]) << 3) | usize::from(data[5] >> 5);
    let header_len = if protection_absent { 7 } else { 9 };
    (frame_len >= header_len).then_some(AdtsHeader::new(object_type, rate_index, channels, header_len, frame_len))
}

impl AdtsHeader {
    const fn new(object_type: u8, rate_index: u8, channels: u8, header_len: usize, frame_len: usize) -> Self {
        Self { object_type, rate_index, channels, header_len, frame_len }
    }
}

/// Builds the `mp4a` sample entry with its `esds` for an AAC stream.
pub fn sample_entry(header: &AdtsHeader) -> Vec<u8> {
    let config =
        [(header.object_type << 3) | (header.rate_index >> 1), ((header.rate_index & 1) << 7) | (header.channels << 3)];
    // DecoderSpecificInfo, inside DecoderConfigDescriptor, inside ES_Descriptor.
    let mut decoder_specific = vec![0x05, 2];
    decoder_specific.extend_from_slice(&config);
    let mut decoder_config = vec![0x04, u8::try_from(13 + decoder_specific.len()).unwrap_or(0)];
    decoder_config.extend_from_slice(&[0x40, 0x15, 0, 0, 0]); // MPEG-4 audio, audio stream, buffer size
    decoder_config.extend_from_slice(&0u32.to_be_bytes()); // max bitrate
    decoder_config.extend_from_slice(&0u32.to_be_bytes()); // average bitrate
    decoder_config.extend_from_slice(&decoder_specific);
    let sl_config = [0x06, 1, 2];
    let mut descriptor = vec![0x03, u8::try_from(3 + decoder_config.len() + sl_config.len()).unwrap_or(0), 0, 1, 0];
    descriptor.extend_from_slice(&decoder_config);
    descriptor.extend_from_slice(&sl_config);

    let mut body = Vec::with_capacity(28 + descriptor.len() + 12);
    body.extend_from_slice(&[0; 6]);
    body.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    body.extend_from_slice(&[0; 8]);
    body.extend_from_slice(&u16::from(header.channels.max(1)).to_be_bytes());
    body.extend_from_slice(&16u16.to_be_bytes()); // sample size
    body.extend_from_slice(&[0; 4]);
    body.extend_from_slice(&(header.sample_rate() << 16).to_be_bytes());
    body.extend_from_slice(&full_box(b"esds", 0, 0, &descriptor));
    mp4_box(b"mp4a", &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_adts_header() {
        // AAC-LC, 48 kHz, stereo, 371-byte frame, no CRC.
        let header = parse_adts(&[0xFF, 0xF1, 0x4C, 0x80, 0x2E, 0x7F, 0xFC]).expect("parses");
        assert_eq!((header.object_type, header.sample_rate(), header.channels), (2, 48000, 2));
        assert_eq!((header.header_len, header.frame_len), (7, 371));
    }
}
