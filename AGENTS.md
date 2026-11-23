# Vixion

Self-hosted recorder for Twitch: records the broadcasts and chat of followed channels and plays them back in the
browser. One static Rust binary serves the API, the web UI and the media. Read this before changing anything.

## Stack

- `server/`: Rust (axum on tokio, rusqlite with migrations in `server/migrations`, rustls, instant-acme). It embeds
  the built web UI.
- `web/`: React, TypeScript, Vite, TanStack Router and Query, Mediabunny, Inter and JetBrains Mono. Bun is tooling only:
  nothing of Bun runs in production.
- Shipped as one container (`Dockerfile`, `compose.yaml`), usually behind Cloudflare Tunnel on a small home server.

## Commands

```
cd web && bun install && bun run dev
cd web && bun run fmt:check && bun run typecheck && bun run lint && bun run test && bun run build
cargo fmt --check
cargo clippy --profile ci --all-targets --locked -- -D warnings
cargo test --profile ci --locked
```

- CI (`.github/workflows/ci.yml`) also runs `bun audit`, `cargo audit` and a smoke test of the built image.
- Releases: `bun scripts/release.ts <patch|minor|major|x.y.z>` moves the changelog's Unreleased section under the new
  version, sets it everywhere, commits and tags. Pushing the tag starts the release workflow. Note user-facing changes
  under Unreleased in `CHANGELOG.md` as you go.

## Layout

- `server/src/recorder`: live detection and recording. `server/src/twitch`: Twitch API, Usher playlists, chat.
- `server/src/media`, `media_server.rs`, `tls.rs`: playback files and the separate HTTPS media port.
- `server/src/api`, `auth.rs`, `crypto.rs`, `audit.rs`: the JSON API, sessions, permissions and audit log.
- `server/src/alerts.rs`, `logs.rs`, `system.rs`, `settings.rs`: alerts and webhooks, logs, disk and system state.
- `web/src`: the UI, in English and French.

## Rules of the product

- Keep CPU and RAM minimal: it runs all the time on small machines.
- No re-encoding, ever: video is kept as Twitch sends it (H.264, HEVC or AV1). No FFmpeg.
- The UI is reached through Cloudflare Tunnel, so media go through a separate built-in HTTPS port with Let's Encrypt
  certificates.
- Twitch's 1440p HEVC is only served to signed-in viewers (the auth token from Settings), through Usher `/api/v2/...`
  with `multigroup_video=true`.
- Chat is stored as JSON and can be downloaded as JSON or as ASS subtitles.
- Security: Argon2id passwords, opaque sessions (only their SHA-256 stored) in an `HttpOnly`, `SameSite=Strict` cookie,
  `Secure` over HTTPS. Every request that changes something must carry `X-Vixion: 1` (CSRF). No default password.

## Rules of the code and interface

- Code, comments, commits and the changelog are in English. Commits: one short sentence saying what changed.
- No plans, roadmaps or working notes in tracked files; `docs/` is git-ignored for that.
- Design follows Vixely's rules: quiet flat chrome, colour only for meaning, icons with short tooltips over text, no
  marketing copy, `cursor: pointer` on everything clickable, in-app dialogs only, both themes and both languages
  checked.
- AGPL-3.0: new dependencies must have a compatible licence.
