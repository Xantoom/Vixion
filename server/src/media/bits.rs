//! Bit reading for codec headers, with H.264's Exp-Golomb codes.

/// Removes the emulation prevention bytes (`00 00 03`) a NAL unit's payload carries.
pub fn unescape_rbsp(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &byte in nal {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

pub struct BitReader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    pub fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.position / 8)?;
        let bit = (byte >> (7 - self.position % 8)) & 1;
        self.position += 1;
        Some(u32::from(bit))
    }

    pub fn bits(&mut self, count: u32) -> Option<u32> {
        (0..count).try_fold(0u32, |value, _| Some((value << 1) | self.bit()?))
    }

    /// Unsigned Exp-Golomb.
    pub fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.bits(zeros)?)
    }

    /// Signed Exp-Golomb.
    pub fn se(&mut self) -> Option<i32> {
        let code = self.ue()?;
        let magnitude = i32::try_from(code.div_ceil(2)).ok()?;
        Some(if code % 2 == 1 { magnitude } else { -magnitude })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_exp_golomb() {
        // 1 | 010 | 011 | 00100 → 0, 1, 2, 3
        let mut reader = BitReader::new(&[0b1010_0110, 0b0100_0000]);
        assert_eq!(reader.ue(), Some(0));
        assert_eq!(reader.ue(), Some(1));
        assert_eq!(reader.ue(), Some(2));
        assert_eq!(reader.ue(), Some(3));
    }

    #[test]
    fn strips_emulation_prevention() {
        assert_eq!(unescape_rbsp(&[0, 0, 3, 1, 0, 0, 3, 0]), vec![0, 0, 1, 0, 0, 0]);
    }
}
