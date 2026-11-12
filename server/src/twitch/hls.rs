//! HLS playlists as Twitch serves them.

use std::collections::HashMap;

/// Parses `KEY=value,KEY="quoted, value"` attribute lists.
pub fn attributes(list: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = list.trim();
    while !rest.is_empty() {
        let Some(eq) = rest.find('=') else { break };
        let key = rest[..eq].trim().to_owned();
        rest = &rest[eq + 1..];
        let value;
        if let Some(quoted) = rest.strip_prefix('"') {
            let end = quoted.find('"').unwrap_or(quoted.len());
            value = quoted[..end].to_owned();
            rest = quoted.get(end + 1..).unwrap_or("");
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            value = rest[..end].to_owned();
            rest = &rest[end..];
        }
        rest = rest.trim_start_matches(',');
        out.insert(key, value);
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Variant {
    pub uri: String,
    pub name: String,
    pub bandwidth: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codecs: String,
    /// Twitch marks the broadcaster's own encode as the source.
    pub source: bool,
    /// The vertical layout of a dual-format broadcast, made for phones.
    pub portrait: bool,
}

impl Variant {
    /// `h264`, `hevc` or `av1`, from the video codec in `CODECS`.
    pub fn video_codec(&self) -> &'static str {
        let codecs = self.codecs.to_ascii_lowercase();
        if codecs.contains("av01") {
            "av1"
        } else if codecs.contains("hvc1") || codecs.contains("hev1") {
            "hevc"
        } else {
            "h264"
        }
    }
}

pub fn parse_multivariant(text: &str) -> Vec<Variant> {
    let mut names: HashMap<String, String> = HashMap::new();
    let mut variants = Vec::new();
    let mut pending: Option<HashMap<String, String>> = None;
    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA:") {
            let attrs = attributes(rest);
            if let (Some(group), Some(name)) = (attrs.get("GROUP-ID"), attrs.get("NAME")) {
                names.insert(group.clone(), name.clone());
            }
        } else if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending = Some(attributes(rest));
        } else if !line.is_empty() && !line.starts_with('#') {
            let Some(attrs) = pending.take() else { continue };
            let (width, height) = attrs
                .get("RESOLUTION")
                .and_then(|res| res.split_once('x'))
                .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
                .unwrap_or((0, 0));
            let group = attrs.get("VIDEO").cloned().unwrap_or_default();
            let name = attrs.get("IVS-NAME").or_else(|| names.get(&group)).cloned().unwrap_or_else(|| group.clone());
            let source = group == "chunked"
                || name.contains("(source)")
                || attrs.get("IVS-VARIANT-SOURCE").is_some_and(|value| value == "source");
            let portrait =
                attrs.get("IVS-GROUPS").is_some_and(|groups| groups.split(',').all(|group| group.trim() == "portrait"));
            variants.push(Variant {
                uri: line.to_owned(),
                name,
                bandwidth: attrs.get("BANDWIDTH").and_then(|b| b.parse().ok()).unwrap_or(0),
                width,
                height,
                fps: attrs.get("FRAME-RATE").and_then(|f| f.parse().ok()).unwrap_or(30.0),
                codecs: attrs.get("CODECS").cloned().unwrap_or_default(),
                source,
                portrait,
            });
        }
    }
    variants
}

fn codec_rank(codec: &str) -> u8 {
    match codec {
        "av1" => 3,
        "hevc" => 2,
        _ => 1,
    }
}

/// The best picture on offer: tallest, then smoothest, then the most efficient codec, then the
/// highest bitrate. Audio-only variants never qualify, and the portrait layout of a dual-format
/// broadcast only when there is nothing else.
pub fn best_variant(variants: &[Variant], h264_only: bool) -> Option<&Variant> {
    let landscape = variants.iter().any(|variant| variant.height > 0 && !variant.portrait);
    variants
        .iter()
        .filter(|variant| variant.height > 0)
        .filter(|variant| !(landscape && variant.portrait))
        .filter(|variant| !h264_only || variant.video_codec() == "h264")
        .max_by(|a, b| {
            (a.height, a.fps.round() as u32, codec_rank(a.video_codec()), a.source, a.bandwidth).cmp(&(
                b.height,
                b.fps.round() as u32,
                codec_rank(b.video_codec()),
                b.source,
                b.bandwidth,
            ))
        })
}

#[derive(Debug, Clone)]
pub struct MediaSegment {
    pub sequence: u64,
    pub uri: String,
    pub duration: f64,
    /// Wall-clock time of the segment's first picture, in Unix milliseconds.
    pub date: Option<i64>,
    pub ad: bool,
    pub discontinuity: bool,
    /// Init segment (fragmented MP4 only).
    pub map: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct MediaPlaylist {
    pub target_duration: f64,
    pub ended: bool,
    pub segments: Vec<MediaSegment>,
}

/// Parses a media playlist. Ads are recognised by their title (not `live`) or by falling inside
/// a `twitch-stitched-ad` date range.
pub fn parse_media(text: &str) -> MediaPlaylist {
    let mut playlist = MediaPlaylist { target_duration: 2.0, ..MediaPlaylist::default() };
    let mut sequence = 0u64;
    let mut ad_ranges: Vec<(i64, i64)> = Vec::new();
    let mut duration = 0.0;
    let mut title = String::new();
    let mut date = None;
    let mut discontinuity = false;
    let mut map = None;
    let mut have_info = false;
    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            playlist.target_duration = rest.parse().unwrap_or(2.0);
        } else if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            sequence = rest.parse().unwrap_or(0);
        } else if line == "#EXT-X-ENDLIST" {
            playlist.ended = true;
        } else if line == "#EXT-X-DISCONTINUITY" {
            discontinuity = true;
        } else if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            map = attributes(rest).get("URI").cloned();
        } else if let Some(rest) = line.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            date = parse_iso8601(rest);
        } else if let Some(rest) = line.strip_prefix("#EXT-X-DATERANGE:") {
            let attrs = attributes(rest);
            let is_ad = attrs.get("CLASS").is_some_and(|class| class == "twitch-stitched-ad")
                || attrs.get("ID").is_some_and(|id| id.starts_with("stitched-ad-"));
            if is_ad && let Some(start) = attrs.get("START-DATE").and_then(|d| parse_iso8601(d)) {
                let length = attrs.get("DURATION").and_then(|d| d.parse::<f64>().ok()).unwrap_or(30.0);
                ad_ranges.push((start, start + (length * 1000.0) as i64));
            }
        } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let (length, name) = rest.split_once(',').unwrap_or((rest, ""));
            duration = length.parse().unwrap_or(0.0);
            title = name.to_owned();
            have_info = true;
        } else if !line.is_empty() && !line.starts_with('#') && have_info {
            let in_ad_range = date.is_some_and(|at| ad_ranges.iter().any(|&(start, end)| at >= start && at < end));
            let ad = in_ad_range || !(title.is_empty() || title.starts_with("live"));
            playlist.segments.push(MediaSegment {
                sequence,
                uri: line.to_owned(),
                duration,
                date,
                ad,
                discontinuity,
                map: map.clone(),
            });
            sequence += 1;
            discontinuity = false;
            have_info = false;
            date = date.map(|at| at + (duration * 1000.0) as i64);
        }
    }
    playlist
}

/// Parses `2026-11-12T14:43:11.142Z` (or with an offset) into Unix milliseconds.
pub fn parse_iso8601(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, time) = text.split_once('T')?;
    let mut parts = date.splitn(3, '-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    let (clock, offset_ms) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else if let Some(at) = time.rfind(['+', '-']) {
        let (clock, zone) = time.split_at(at);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = zone[1..].split_once(':').unwrap_or((&zone[1..3.min(zone.len())], "0"));
        let minutes: i64 = hours.parse::<i64>().ok()? * 60 + minutes.parse::<i64>().unwrap_or(0);
        (clock, sign * minutes * 60_000)
    } else {
        (time, 0)
    };
    let mut clock_parts = clock.splitn(3, ':');
    let hour: i64 = clock_parts.next()?.parse().ok()?;
    let minute: i64 = clock_parts.next()?.parse().ok()?;
    let seconds: f64 = clock_parts.next().unwrap_or("0").parse().ok()?;
    // Days from the civil date, after Howard Hinnant's algorithm.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms = ((days * 24 + hour) * 60 + minute) * 60_000 + (seconds * 1000.0).round() as i64;
    Some(ms - offset_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_the_portrait_layout_of_dual_format_broadcasts() {
        let playlist = "#EXTM3U\n\
            #EXT-X-STREAM-INF:BANDWIDTH=8042999,RESOLUTION=1920x1080,CODECS=\"avc1.4D401F,mp4a.40.2\",FRAME-RATE=60.000,IVS-NAME=\"1080p60\",IVS-GROUPS=\"landscape\",IVS-VARIANT-SOURCE=\"source\"\n\
            https://example.com/landscape.m3u8\n\
            #EXT-X-STREAM-INF:BANDWIDTH=208448,CODECS=\"mp4a.40.2\",IVS-NAME=\"audio_only\",IVS-GROUPS=\"landscape,portrait\"\n\
            https://example.com/audio.m3u8\n\
            #EXT-X-STREAM-INF:BANDWIDTH=5673838,RESOLUTION=1080x1920,CODECS=\"hev1.1.6.L123.90.0.0.0.0.0,mp4a.40.2\",FRAME-RATE=60.000,IVS-NAME=\"1080p60\",IVS-GROUPS=\"portrait\"\n\
            https://example.com/portrait.m3u8\n";
        let variants = parse_multivariant(playlist);
        assert_eq!(variants.len(), 3);
        assert!(variants[2].portrait && !variants[1].portrait);
        let best = best_variant(&variants, false).expect("a variant");
        assert_eq!(best.uri, "https://example.com/landscape.m3u8");
        // A portrait-only broadcast is still recorded.
        let portrait_only: Vec<_> = variants.into_iter().filter(|variant| variant.portrait).collect();
        assert!(best_variant(&portrait_only, false).is_some());
    }

    #[test]
    fn parses_dates() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("2026-11-12T14:43:11.142Z"), Some(1_794_494_591_142));
        assert_eq!(parse_iso8601("2026-11-12T15:43:11.142+01:00"), Some(1_794_494_591_142));
    }

    #[test]
    fn marks_ads_and_picks_the_source() {
        let media = "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:7\n\
            #EXT-X-DATERANGE:ID=\"stitched-ad-1\",CLASS=\"twitch-stitched-ad\",START-DATE=\"2026-11-12T14:43:11.142Z\",DURATION=4.0\n\
            #EXT-X-PROGRAM-DATE-TIME:2026-11-12T14:43:11.142Z\n#EXTINF:2.000,Amazon|123\nhttps://a/1.ts\n\
            #EXT-X-PROGRAM-DATE-TIME:2026-11-12T14:43:13.142Z\n#EXTINF:2.000,live\nhttps://a/2.ts\n\
            #EXT-X-PROGRAM-DATE-TIME:2026-11-12T14:43:15.142Z\n#EXTINF:2.000,live\nhttps://a/3.ts\n";
        let playlist = parse_media(media);
        let ads: Vec<_> = playlist.segments.iter().map(|segment| (segment.sequence, segment.ad)).collect();
        assert_eq!(ads, vec![(7, true), (8, true), (9, false)]);

        let master = "#EXTM3U\n#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID=\"chunked\",NAME=\"1080p60 (source)\"\n\
            #EXT-X-STREAM-INF:BANDWIDTH=7000000,RESOLUTION=1920x1080,CODECS=\"avc1.64002A,mp4a.40.2\",VIDEO=\"chunked\",FRAME-RATE=60.000\nhttps://s/1080.m3u8\n\
            #EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,CODECS=\"hvc1.2.4.L150,mp4a.40.2\",VIDEO=\"1440p60\",FRAME-RATE=60.000\nhttps://s/1440.m3u8\n\
            #EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS=\"avc1.4D401F,mp4a.40.2\",VIDEO=\"720p60\",FRAME-RATE=60.000\nhttps://s/720.m3u8\n";
        let variants = parse_multivariant(master);
        assert_eq!(best_variant(&variants, false).map(|v| v.height), Some(1440));
        assert_eq!(best_variant(&variants, true).map(|v| v.uri.as_str()), Some("https://s/1080.m3u8"));
    }
}
