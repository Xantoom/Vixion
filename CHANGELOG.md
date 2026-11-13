# Changelog

Every notable change to Vixion is listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Write each change under **Unreleased** as it lands, in the section that fits: Added, Changed,
Fixed, Removed, Security. `bun scripts/release.ts` turns that section into the next version.

## [Unreleased]

### Added

- Checks Twitch on its own, every 30 seconds with a few channels and less often with hundreds, backing off
  when Twitch asks to.
- Records every broadcast of the channels you add, at source quality, H.264, HEVC or AV1 as
  Twitch sends it, with an H.264-only option. 1440p HEVC needs a Twitch account token.
- Skips ads, either with a Turbo or subscriber token or by switching players. The token is set with
  `VIXION_TWITCH_TOKEN`, `VIXION_TWITCH_TOKEN_FILE` or `--twitch-token`; the settings show it masked.
- Records chat and replays it in sync, with badges, Twitch, 7TV, BetterTTV and FrankerFaceZ
  emotes, timestamps that jump to the moment, and names linking to Twitch.
- Downloads of the video, the chat as JSON and as ASS subtitles, or both.
- Search bar for Twitch channels with suggestions; each channel has a page with its banner,
  live broadcast, recordings and past broadcasts still on Twitch, and an add button.
- Studio player: full-height video with chat filling the rest of the width, timeline and
  chapter list by category, seeking on press, keyboard shortcuts, full screen, and a compressor
  that evens out loud and quiet moments. The chat shows the last hundred messages at the
  playhead and older ones on scrolling up. A broadcast still being recorded opens once it ends.
- Each recording reopens where it was left, and its card shows how far it was watched.
- Administration page gathering statistics, logs, users and settings.
- Recordings are deleted after 14 days unless kept forever; per-streamer retention.
- Accounts with roles and per-person permissions; statistics, logs and alerts by webhook.
- Built-in HTTPS for the video address, with Let's Encrypt certificates through Cloudflare DNS.
- English and French; light, dark or system theme.
