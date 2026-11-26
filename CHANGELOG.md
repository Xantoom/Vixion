# Changelog

Every notable change to Vixion is listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Write each change under **Unreleased** as it lands, in the section that fits: Added, Changed,
Fixed, Removed, Security. `bun scripts/release.ts` turns that section into the next version.

## [Unreleased]

### Changed

- Scrollbars are rounded and thicken under the pointer, without the arrow buttons Windows draws (xantoom-design 0.2.1).
- The stylesheet only loads the design system's foundation (tokens, reset, base, motion, utilities), not its unused
  components, so it is lighter (xantoom-design 0.2.2).

### Fixed

- The stage behind a recording is darker than the page in both themes again.

## [0.4.6] - 2026-11-26

### Changed

- New logo: the same ring, V and live dot on a warm gradient tile, one drawing for both themes.
- The interface is built on the Xantoom design system, shared with the other Xantoom apps: its grounds, text and
  status colours, Inter first, softer corners, the accent as the focus ring, and two-layer shadows. The warm accent
  gradient stays.
- Under reduced motion, hover zooms and lifts no longer move, and the chat column no longer slides.

### Fixed

- A stream card whose title fits on one line no longer leaves an empty line before its date.

## [0.4.5] - 2026-11-23

### Changed

- The player's chat column is wider on desktop, matching Twitch's theatre mode (around 340 px, expanding into spare
  width on ultrawide screens).

## [0.4.4] - 2026-11-23

### Security

- Updated the `url` library past RUSTSEC-2026-0592 (a crash on nested `blob:` addresses).

## [0.4.3] - 2026-11-23

### Added

- The player saves the frame on screen as a PNG, at the video's own size.
- Hovering a game's name on a channel's cards shows its box art; hovering the date shows it in full.

### Changed

- Channel cards always show their delete and keep buttons, give the date as day, month, year and time, and all have
  the same size whatever their title.
- On a desktop the video fills the player's height and the chat takes the width left; showing or hiding the chat
  slides it.

### Fixed

- Chat emotes look sharp on scaled screens and are never stretched.
- A click just above the player's timeline or below its title pauses the video again.
- The player's controls fade out after a shortcut key, even when a button was clicked just before.

## [0.4.2] - 2026-11-21

### Removed

- The streamer's Twitch bio on their channel page.

## [0.4.1] - 2026-11-21

### Changed

- Chat emotes are sized by the text around them, as on Twitch, instead of standing out at twice its height.

### Fixed

- After a jump in the video, the chat shows the lines before the new time as soon as they come, instead of waiting for the next five minutes of chat: clicking quickly around the timeline no longer leaves the old chat (or an empty one) on screen.
- Chat emotes no longer appear a moment after their line and push the lines around on every jump.
- The chat stays on its last line when its panel changes height (full screen, a phone turned, the window resized).

## [0.4.0] - 2026-11-21

### Added

- A recording cut by hand can be resumed from the live card while the broadcast lasts; it carries on in the same stream.
- The live card shows the category's cover art, with the viewer count and the broadcast's length on its picture.

### Changed

- Cutting a recording moved from the streamer's settings to the button on the stream being recorded.
- A recording in progress is marked with a red recording icon instead of a sentence.
- The channel page puts the picture beside the name, the settings button in the top corner under the banner (filled with the accent under the pointer), and a proper « Live » label beside the name.
- In French, a streamer's broadcasts are called « streams » instead of « enregistrements » or « lives » (« Conserver le stream », « Enregistrer ses streams »…), and « Réglages » became « Paramètres ».

### Fixed

- On a phone, the channel page keeps the name whole (the live label and badge go under it), the settings button stays in its corner as an icon, and « Record » takes its own row.
- On a phone, dialog buttons share the width and stack with the main one on top when they don't fit side by side; the retention menu goes under its label.
- In development, dialogs opened straight away (a streamer's settings) closed at once.
- The broadcast on air, in the « On Twitch » tab, shows the live picture until Twitch has one, and the tab asks Twitch again each time it is opened.

## [0.3.2] - 2026-11-20

### Changed

- A finished recording's thumbnail is kept by the browser instead of being asked for again every five minutes.

### Fixed

- A new recording could take the id of a deleted one, and the place a browser remembered for the old video applied to it. Recordings now get random ids that are never reused; existing ones are renumbered once, so where each was left is forgotten one time.
- Deleting a recording, or a streamer with their recordings, forgets where they were left in this browser.

## [0.3.1] - 2026-11-18

### Changed

- The media certificate is now kept as one file per ACME directory (key and chain together): it is requested once more after updating, and a staging certificate is never served in production.
- Channel pages refresh every two minutes unless the channel is live or being recorded.
- At most four chat downloads are written at once; others wait their turn.

### Fixed

- A recording stopped by hand stays stopped after a restart (such as an update) instead of being recorded again; the stop button answers once the recording is closed, so the page shows it stopped at once.
- A chat connection gone silent is noticed after six minutes and reconnected: before, the periodic flush kept the deadline from ever passing.
- A recording that crashes no longer leaves its chat task spinning the CPU, and stopping no longer waits for a chat connection or a Twitch check in progress.
- A playlist with a NaN duration no longer crashes the recording.
- Deleting several parts at once no longer leaves their folder behind, retention no longer deletes a recording kept forever (or resumed) after it picked it, and a resumed recording can't lose its file to a deletion.
- A recording whose closing fails keeps its duration and size; one closed just before a crash keeps its full duration; a timeline that can't be saved raises an alert.
- MP4 segments with several sample tables are read correctly, and a damaged table can't fill memory.
- A download left hanging no longer holds a server thread for good.
- Chat lines said at the same moment (those during a cut ad) can all be read back, the 5,000 kept lines never push out those at the playhead, and a network failure is retried with growing waits, even while paused.
- When audio decoding fails, the video goes on from where it was instead of jumping; seeking past the end of the sound no longer leaves the player waiting, and the sound ending first no longer stops the video.
- The refresh button no longer opens the player twice; a link older than six hours is fetched again before playing.
- Open alerts stay listed however many events come after them.
- A still valid certificate is served while its renewal is retried; DDNS turns the Cloudflare proxy off even when the address is right.
- The data folder is created at first start; a stray `%` in the address no longer stops the app; the Twitch tab falls back to recordings when Twitch can't be reached; a failed sign-out says so.
- Very large answers are sent without an ETag instead of failing.

### Security

- The last administrator can't be removed by two changes at once, and clearing a permission exception or deleting a role can't give someone more than the manager holds.

## [0.3.0] - 2026-11-15

### Added

- Hovering an emote shows it larger, with where it comes from (Twitch, 7TV, BTTV or FFZ); hovering a badge shows it larger too.
- A deleted message can be clicked to show what it said, in muted text.
- A message's time hint also gives the date and hour it was sent, and a name's hint gives the login when the display name differs.

### Changed

- Subscriber badges say for how long: "Subscriber for 1 year 2 months", with the tier above 1. Chat recorded from now on keeps Twitch's exact months; older recordings use the badge's step.
- Every badge's hint is in the interface's language (founder, bits, gift subs, predictions…), and others use Twitch's title instead of their internal name.
- Interface texts are shorter: no welcome lines or explanations of what the screen already shows.
- Alerts are shown in the interface's language, with the error itself kept as a detail.
- A channel that isn't recorded says so on its card, and only its pictures fade.
- On a phone, tapping an info icon, an emote or a badge shows its hint.
- The player's seek bar is announced as the playback position, and the administration link says how many alerts are open.
- Segmented choices take one Tab stop and move with the arrow keys.
- In French, saving says "Valider": "Enregistrer" already means recording a live.
- How long recordings are kept is picked from the same lengths for the whole server and for one streamer (1 week, 1 month, 3 months, 1 year, forever); a length set before stays listed.
- The statistics show the disk across the page, the counts in a row under it.
- The users page uses the same cards as the other administration pages.
- A recording without a thumbnail shows a film mark rather than an empty box.

### Fixed

- The player's active buttons, its error text and the toasts' icons keep readable colours in the light theme.
- Library names in the logs are readable, and the add buttons of the users page and the show-password button are big enough to tap.
- On a small player, the large play button no longer covers the picture.
- Delete buttons, the failed mark and the alert count are readable in the dark theme, and warnings in the light console.
- Streamer cards no longer cut their facts short, and a channel's header no longer floats at medium widths.
- On a small player, an error and its button stay clear of the title and the controls; the console scrolls with the keyboard.

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
- _Settings_ no longer reveals or copies the Twitch token.

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

[Unreleased]: https://github.com/Xantoom/Vixion/compare/v0.4.6...HEAD
[0.4.6]: https://github.com/Xantoom/Vixion/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/Xantoom/Vixion/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/Xantoom/Vixion/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/Xantoom/Vixion/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/Xantoom/Vixion/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Xantoom/Vixion/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Xantoom/Vixion/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/Xantoom/Vixion/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Xantoom/Vixion/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Xantoom/Vixion/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Xantoom/Vixion/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Xantoom/Vixion/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Xantoom/Vixion/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Xantoom/Vixion/releases/tag/v0.1.0
