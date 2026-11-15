# Changelog

Every notable change to Vixion is listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Write each change under **Unreleased** as it lands, in the section that fits: Added, Changed,
Fixed, Removed, Security. `bun scripts/release.ts` turns that section into the next version.

## [Unreleased]

## [0.2.2] - 2026-11-15

### Added

- The statistics show the server's memory, and the container's with how much of it is disk cache.

### Fixed

- Recorded and watched video no longer piles up in the disk cache, which Docker counts as the container's memory: it grew by hundreds of megabytes a day.
- Connections of viewers whose network vanished are closed after about two minutes instead of staying open until a restart.
- Emote lists and chat indexes are let go when nobody uses them, and a chat index takes a third less memory.
- Log lines kept for the console are cut at 2 kB, and the database keeps a smaller cache.
- The player keeps fewer preview pictures and chat lines in memory.

## [0.2.1] - 2026-11-15

### Fixed

- Recordings interrupted by a crash are repaired without being read into memory: a long one could get the server killed at every start.
- A damaged video segment or date from Twitch no longer crashes a recording, stops the live checks or fills memory.
- The live checks start again by themselves, with an alert, if they ever crash.
- One failed database call no longer stops every later write until a restart.
- Parts of a broadcast merged into one file keep the right track numbers.

### Security

- Sign-in attempts are counted per IPv6 /64, so one machine can't guess without limit or lock everyone out.
- `vixion reset-password` no longer shows the password as it is typed.
- Answers from Twitch, Cloudflare and the router are read up to a size limit.
- The Twitch and Cloudflare tokens are left out of the configuration when it is printed.

## [0.2.0] - 2026-11-14

### Added

- `VIXION_UPNP` opens the video port on the router by UPnP, as Plex does, renews it and closes it on shutdown.
- `--port` and `--video-port` choose the ports without Docker.

### Changed

- **The ports are now 6280 (interface) and 6281 (video)**, away from those other self-hosted apps take: update the
  `ports:` of your compose file (`"6280:6280"` and `"6281:6281"`).
- The video always has its own port. On a local network it needs no setting: the browser asks for it at the
  interface's address, on port 6281. `VIXION_MEDIA_MODE`, `VIXION_HTTP_ADDR` and `VIXION_MEDIA_ADDR` are gone;
  `VIXION_MEDIA_DOMAIN` with a Cloudflare token or certificate files turns HTTPS on by itself.
- The Twitch token is required: Vixion doesn't start without `VIXION_TWITCH_TOKEN`. One saved from the interface by
  an earlier version still works, with a warning in the log.
- *Settings* no longer reveals or copies the Twitch token.

### Fixed

- The server's errors show in the interface's language.

## [0.1.0] - 2026-11-14

### Added

- A setup code, printed in the server's log, is asked for when creating the first account.
- `VIXION_TRUST_PROXY`: client addresses are read from proxy headers only when it is set.
- A lasting audit log of account, role, setting and recording changes, and of token reveals.
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
- Two volumes in the image: `/config` for the database, keys and certificates, `/recordings` for
  the recordings (`VIXION_RECORDINGS_DIR` outside Docker; by default `streams` in the data folder).
- Recordings are deleted after 14 days unless kept forever; per-streamer retention.
- Accounts with roles and per-person permissions; statistics, logs and alerts by webhook.
- Built-in HTTPS for the video address, with Let's Encrypt certificates through Cloudflare DNS.
- English and French; light, dark or system theme.

### Changed

- The player works held sideways on phones and tablets: video and chat side by side. A button
  (or C) hides the chat; in full screen on a touch screen the video takes it all and turns to
  landscape. Its title and controls are lighter on a small player.
- Fields are easier to use: taller on touch screens, white with a clear edge, numbers with − and +
  buttons and checked when left rather than at every key; larger switches.
- Menus stay on screen: they slide back in by an edge and scroll when taller than the room.
- The server card shows the configuration and recordings folders, where they come from on the
  host (or that they aren't mounted) and their free space, instead of the memory used.
- The administration pages fit phones and tablets: tabs in a grid, statistics as a list, logs and
  accounts that wrap instead of overflowing.
- The light theme has a light grey page, with white cards and panels.
- A new logo in the family of Vixeeny: a V in a ring running back to a red recording dot, dark on
  light pages and light on dark ones, with a home-screen icon.
- API answers are compressed (Brotli or gzip) and carry ETags, so unchanged lists come back empty.
- Chat is served from the file through a small index: a long, busy chat takes a few megabytes of
  memory instead of hundreds, and chat downloads start at once.
- Lighter player (MP4 only), smaller channel avatars, emotes fetched as soon as a recording starts,
  and database indexes for folder lookups and purges.
- Release binaries and images use mimalloc, tuned to rest at a few megabytes: musl's allocator
  served video at half the speed.
- A panic ends only the recording it happened in, which is then repaired, instead of the whole server.
- Images are built on Debian 13 distroless, with base images and Rust (1.100) pinned and kept up to
  date by Dependabot.

### Fixed

- Updating can't lose settings: one stored setting a version can't read falls back alone, instead of
  every setting going back to its default (a retention of "forever" turning into fourteen days).
- The database is copied to `vixion.db.before-vN` before an update changes it, a failed update is
  rolled back, and a database from a newer version is left untouched.
- Retention waits until broadcasts left in parts are merged, so it never deletes a part being merged.
- A tab left open across an update reloads once instead of showing a blank page, and a page that
  fails to draw offers to reload.
- The live console connects at once behind a reverse proxy, instead of after fifteen seconds.
- A recording part counts only its own skipped ads and chat messages: merged parts no longer double them.

### Security

- Media links belong to one account and stop working when it loses access; downloads need their
  own signed link.
- Someone who manages accounts can't grant anyone, themselves included, more than they hold.
- Changing one's password signs out the other devices.
- Sign-in hashing runs a few at a time, so a flood of attempts can't exhaust memory.
- Releases run every check first, and publish `SHA256SUMS` and signed build provenance for the
  binaries and images (`gh attestation verify`).
- The release workflow's write access is limited to its last step, and actions are pinned by commit.
- The compose file runs the container read-only, without capabilities or privilege escalation.

[Unreleased]: https://github.com/Xantoom/Vixion/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Xantoom/Vixion/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Xantoom/Vixion/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Xantoom/Vixion/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Xantoom/Vixion/releases/tag/v0.1.0
