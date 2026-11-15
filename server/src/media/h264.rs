//! H.264: the sequence parameter set's picture size, and the `avc1` sample entry.

use super::bits::{BitReader, unescape_rbsp};
use super::{MediaError, err, mp4_box};

pub const NAL_IDR: u8 = 5;
pub const NAL_SPS: u8 = 7;
pub const NAL_PPS: u8 = 8;
pub const NAL_AUD: u8 = 9;

/// What the sample entry needs from a sequence parameter set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpsInfo {
    pub profile: u8,
    pub compatibility: u8,
    pub level: u8,
    pub chroma_format: u32,
    pub bit_depth_luma: u32,
    pub bit_depth_chroma: u32,
    pub width: u32,
    pub height: u32,
}

fn skip_scaling_list(reader: &mut BitReader<'_>, size: usize) -> Option<()> {
    let mut last = 8i32;
    let mut next = 8i32;
    for _ in 0..size {
        if next != 0 {
            next = (last + reader.se()? + 256) % 256;
        }
        if next != 0 {
            last = next;
        }
    }
    Some(())
}

/// Parses a sequence parameter set NAL unit, header byte included.
pub fn parse_sps(nal: &[u8]) -> Option<SpsInfo> {
    let rbsp = unescape_rbsp(nal.get(1..)?);
    let mut reader = BitReader::new(&rbsp);
    let profile = u8::try_from(reader.bits(8)?).ok()?;
    let compatibility = u8::try_from(reader.bits(8)?).ok()?;
    let level = u8::try_from(reader.bits(8)?).ok()?;
    reader.ue()?; // seq_parameter_set_id
    let (mut chroma_format, mut bit_depth_luma, mut bit_depth_chroma) = (1, 8, 8);
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
        chroma_format = reader.ue()?;
        if chroma_format == 3 {
            reader.bit()?; // separate_colour_plane_flag
        }
        bit_depth_luma = reader.ue()?.checked_add(8)?;
        bit_depth_chroma = reader.ue()?.checked_add(8)?;
        reader.bit()?; // qpprime_y_zero_transform_bypass_flag
        if reader.bit()? == 1 {
            let lists = if chroma_format == 3 { 12 } else { 8 };
            for index in 0..lists {
                if reader.bit()? == 1 {
                    skip_scaling_list(&mut reader, if index < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    reader.ue()?; // log2_max_frame_num_minus4
    match reader.ue()? {
        0 => {
            reader.ue()?;
        }
        1 => {
            reader.bit()?;
            reader.se()?;
            reader.se()?;
            for _ in 0..reader.ue()? {
                reader.se()?;
            }
        }
        _ => {}
    }
    reader.ue()?; // max_num_ref_frames
    reader.bit()?; // gaps_in_frame_num_value_allowed_flag
    let width_mbs = reader.ue()?.checked_add(1)?;
    let height_map_units = reader.ue()?.checked_add(1)?;
    let frame_mbs_only = reader.bit()?;
    if frame_mbs_only == 0 {
        reader.bit()?; // mb_adaptive_frame_field_flag
    }
    reader.bit()?; // direct_8x8_inference_flag
    let (mut crop_left, mut crop_right, mut crop_top, mut crop_bottom) = (0, 0, 0, 0);
    if reader.bit()? == 1 {
        crop_left = reader.ue()?;
        crop_right = reader.ue()?;
        crop_top = reader.ue()?;
        crop_bottom = reader.ue()?;
    }
    let (sub_width, sub_height) = match chroma_format {
        1 => (2, 2),
        2 => (2, 1),
        _ => (1, 1),
    };
    let (crop_x, crop_y) =
        if chroma_format == 0 { (1, 2 - frame_mbs_only) } else { (sub_width, sub_height * (2 - frame_mbs_only)) };
    // Sizes come from the stream: a damaged one must not overflow.
    let crop = |unit: u32, a: u32, b: u32| a.checked_add(b)?.checked_mul(unit);
    let width = width_mbs.checked_mul(16)?.checked_sub(crop(crop_x, crop_left, crop_right)?)?;
    let height = (2 - frame_mbs_only).checked_mul(height_map_units)?.checked_mul(16)?.checked_sub(crop(
        crop_y,
        crop_top,
        crop_bottom,
    )?)?;
    Some(SpsInfo { profile, compatibility, level, chroma_format, bit_depth_luma, bit_depth_chroma, width, height })
}

/// Builds the `avc1` sample entry from one SPS and one or more PPS.
pub fn sample_entry(sps: &[u8], pps: &[Vec<u8>]) -> Result<(Vec<u8>, SpsInfo), MediaError> {
    let Some(info) = parse_sps(sps) else { return err("unreadable H.264 sequence parameter set") };
    let mut avcc = vec![1, info.profile, info.compatibility, info.level, 0xFF, 0xE1];
    avcc.extend_from_slice(&u16::try_from(sps.len()).unwrap_or(0).to_be_bytes());
    avcc.extend_from_slice(sps);
    avcc.push(u8::try_from(pps.len()).unwrap_or(1));
    for set in pps {
        avcc.extend_from_slice(&u16::try_from(set.len()).unwrap_or(0).to_be_bytes());
        avcc.extend_from_slice(set);
    }
    if matches!(info.profile, 100 | 110 | 122 | 144) {
        avcc.push(0xFC | u8::try_from(info.chroma_format & 3).unwrap_or(1));
        avcc.push(0xF8 | u8::try_from((info.bit_depth_luma - 8) & 7).unwrap_or(0));
        avcc.push(0xF8 | u8::try_from((info.bit_depth_chroma - 8) & 7).unwrap_or(0));
        avcc.push(0);
    }

    let mut body = Vec::with_capacity(86 + avcc.len());
    body.extend_from_slice(&[0; 6]);
    body.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    body.extend_from_slice(&[0; 16]); // pre_defined and reserved
    body.extend_from_slice(&u16::try_from(info.width).unwrap_or(0).to_be_bytes());
    body.extend_from_slice(&u16::try_from(info.height).unwrap_or(0).to_be_bytes());
    body.extend_from_slice(&0x0048_0000u32.to_be_bytes()); // 72 dpi
    body.extend_from_slice(&0x0048_0000u32.to_be_bytes());
    body.extend_from_slice(&0u32.to_be_bytes());
    body.extend_from_slice(&1u16.to_be_bytes()); // frame_count
    body.extend_from_slice(&[0; 32]); // compressorname
    body.extend_from_slice(&0x0018u16.to_be_bytes()); // depth
    body.extend_from_slice(&(-1i16).to_be_bytes());
    body.extend_from_slice(&mp4_box(b"avcC", &avcc));
    Ok((mp4_box(b"avc1", &body), info))
}

/// Position of the first `00 00 01` start code.
pub fn find_start_code(data: &[u8]) -> Option<usize> {
    data.windows(3).position(|window| window == [0, 0, 1])
}

/// Splits an Annex B byte stream into NAL units, start codes removed.
pub fn split_annex_b(data: &[u8]) -> Vec<&[u8]> {
    let mut units = Vec::new();
    let mut start = None;
    let mut index = 0;
    while index + 2 < data.len() {
        if data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1 {
            if let Some(begin) = start {
                // A four-byte start code leaves a zero at the end of the previous unit.
                let mut end = index;
                while end > begin && data[end - 1] == 0 {
                    end -= 1;
                }
                units.push(&data[begin..end]);
            }
            index += 3;
            start = Some(index);
        } else {
            index += 1;
        }
    }
    if let Some(begin) = start
        && begin < data.len()
    {
        units.push(&data[begin..]);
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_1080p_high_profile_sps() {
        // High profile, level 4.2, 1920x1080 (1088 cropped by 8).
        let sps = [
            0x67, 0x64, 0x00, 0x2A, 0xAC, 0x2C, 0x6A, 0x81, 0xE0, 0x08, 0x9F, 0x96, 0x6E, 0x02, 0x02, 0x02, 0x80, 0x00,
            0x00, 0x03, 0x00, 0x80, 0x00, 0x00, 0x1E, 0x42,
        ];
        let info = parse_sps(&sps).expect("parses");
        assert_eq!((info.profile, info.level), (100, 42));
        assert_eq!((info.width, info.height), (1920, 1080));
    }

    #[test]
    fn splits_start_codes() {
        let stream = [0, 0, 0, 1, 9, 0xF0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3];
        assert_eq!(split_annex_b(&stream), vec![&[9, 0xF0][..], &[0x67, 1, 2][..], &[0x68, 3][..]]);
    }
}
