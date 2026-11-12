<div align="center">

<img alt="Vixion" src="web/public/favicon.svg" width="64" height="64" />

# Vixion

**Records the Twitch channels you follow, chat included, and plays them back in your browser.**

</div>

## What it does

- **Records every broadcast** of the channels you add, at source quality, as soon as they go live. HEVC and AV1 are
  kept as Twitch sends them, or H.264 only if you prefer.
- **Records the chat** and replays it in sync with the video: badges, Twitch, 7TV, BetterTTV and FrankerFaceZ
  emotes, timestamps that jump to the moment.
- **Find channels** from the search bar; each has a page with its live broadcast, recordings and past broadcasts,
  and is added from there.
- **Skips ads**: with a Turbo or subscriber token Twitch sends none; without one, Vixion switches players when an ad
  starts, leaving short gaps instead of ads.
- **Plays back** in a studio view: video and chat side by side, ±5 s, volume, full screen, and a compressor that evens
  out quiet talk and loud moments. Downloads the video, the chat (JSON), or the chat as subtitles (ASS).
- **Keeps the disk in check**: recordings expire after 14 days unless kept forever; when space runs low the oldest go
  first. Statistics show what each streamer takes.
- **Several people**: administrators, users and custom roles, with permissions per role and per person.
- **Small**: one static binary of a few megabytes, a few megabytes of memory at rest. Logs, alerts, and webhooks
  (Discord, ntfy or JSON) when something needs attention.

English and French. Phones, tablets, desktops and TVs.

Vixion is not affiliated with Twitch. Record only what you're allowed to keep.

## Install

### Docker Compose

```bash
curl -O https://raw.githubusercontent.com/Xantoom/Vixion/main/compose.yaml
mkdir data
docker compose up -d
```

Open `http://your-server:8080` and create the administrator account.

### Docker

```bash
docker run -d --name vixion --restart unless-stopped --stop-timeout 30 \
  -p 8080:8080 -v ./data:/data --user "$(id -u):$(id -g)" \
  ghcr.io/xantoom/vixion:latest
```

### Binary

Static Linux binaries (x86_64, aarch64) are attached to each [release](https://github.com/Xantoom/Vixion/releases).

```bash
VIXION_DATA_DIR=/var/lib/vixion ./vixion
```

`vixion reset-password <user> <password>` sets a forgotten password. `vixion healthcheck` exits 0 when the server
answers.

## Video and Cloudflare Tunnel

The interface and the video can be served apart, like Plex does. A Cloudflare Tunnel in front of the interface is fine
for pages, but its terms don't allow carrying video, and it would slow it down. Three modes:

| `VIXION_MEDIA_MODE` | Video is served                         | Use it when                                                    |
| ------------------- | --------------------------------------- | -------------------------------------------------------------- |
| `same` (default)    | by the interface's address, under /media | on a local network, or behind your own reverse proxy           |
| `https`             | on its own port with its own certificate | the interface is behind a Cloudflare Tunnel                    |
| `http`              | on its own port, plain HTTP              | your own proxy (Caddy, Traefik) handles TLS for that port      |

For `https`, give Vixion a domain and a Cloudflare API token (permissions *Zone → Zone → Read* and
*Zone → DNS → Edit*). It gets a Let's Encrypt certificate by DNS challenge (nothing to open but the video port) and
renews it. With `VIXION_DDNS=true` it also keeps the domain's A record on your public address, unproxied.

```yaml
environment:
  VIXION_MEDIA_MODE: https
  VIXION_MEDIA_DOMAIN: media.example.com
  VIXION_CLOUDFLARE_API_TOKEN: your-token
  VIXION_DDNS: "true"
```

Then forward port 8443 to the server on your router. Video links are signed and expire after 12 hours: nobody can
watch without signing in to the interface first.

## Configuration

Everything that changes while the app runs (retention, codecs, Twitch token, webhooks) is in the **Settings** page.
The environment only wires the process:

| Variable                      | Default        | What it does                                                          |
| ----------------------------- | -------------- | --------------------------------------------------------------------- |
| `VIXION_DATA_DIR`             | `./data`       | Database, recordings and keys                                         |
| `VIXION_HTTP_ADDR`            | `0.0.0.0:8080` | The interface                                                         |
| `VIXION_MEDIA_MODE`           | `same`         | `same`, `http` or `https` (see above)                                 |
| `VIXION_MEDIA_ADDR`           | `0.0.0.0:8443` | The video listener, in `http` and `https` modes                       |
| `VIXION_MEDIA_DOMAIN`         |                | The video domain, in `https` mode                                     |
| `VIXION_MEDIA_PUBLIC_PORT`    | listener port  | The port browsers use, when the router forwards another one          |
| `VIXION_MEDIA_PUBLIC_URL`     |                | The video origin browsers use (required in `http` mode)               |
| `VIXION_CLOUDFLARE_API_TOKEN` |                | Let's Encrypt by DNS challenge, and DDNS                              |
| `VIXION_ACME_EMAIL`           |                | Contact for Let's Encrypt                                             |
| `VIXION_ACME_STAGING`         | `false`        | Use Let's Encrypt's staging server while testing                      |
| `VIXION_ACME_DIRECTORY`       | Let's Encrypt  | Another ACME certificate authority's directory URL                    |
| `VIXION_TLS_CERT`, `_KEY`     |                | Your own certificate files instead of Let's Encrypt                   |
| `VIXION_DDNS`                 | `false`        | Keep the video domain's A record on the public address                |
| `VIXION_LOG`                  | `info`         | Log level: `error`, `warn`, `info`, `debug`                           |
| `VIXION_LOG_FORMAT`           | text           | `json` for log collectors                                             |

### Twitch token (no ads)

With a Turbo or subscribed account, paste the value of the `auth-token` cookie of twitch.tv (browser developer tools →
Application → Cookies) in *Settings → Twitch*. It is stored encrypted and only sent to Twitch.

## Player shortcuts

`Space` or `K` play/pause · `←` `→` 5 s · `J` `L` 10 s · `↑` `↓` volume · `M` mute · `F` full screen ·
`Home` `End` start and end · `/` search. Clicking the timeline jumps at once; chapters follow the broadcast's
categories. On a touchscreen, double-tap the sides to jump 5 s.

The player decodes with [Mediabunny](https://mediabunny.dev) and WebCodecs on HTTPS pages, and falls back to the
browser's video element on plain HTTP, where WebCodecs isn't available. A browser that can't decode HEVC or AV1 offers
the download instead.

## Development

Needs [Bun](https://bun.sh) and Rust (stable).

```bash
cd web && bun install && bun run build && cd ..
cargo run -- serve
```

`cd web && bun run dev` serves the interface with hot reload on port 5173, against the server on 8080.

```bash
cargo fmt --check && cargo clippy --all-targets && cargo test --profile ci
cd web && bun run fmt:check && bun run typecheck && bun run lint
```

## Versions

Vixion follows [Semantic Versioning](https://semver.org): a patch release fixes, a minor release adds, a major
release asks you to change something (configuration, data) before upgrading, and says what in the changelog.
[CHANGELOG.md](CHANGELOG.md) lists every change. Images are tagged with the full version (`0.2.1`), the minor line
(`0.2`) and `latest`; pin the minor line to get fixes without surprises.

To cut a release, write the changes under *Unreleased* in the changelog, then:

```bash
bun scripts/release.ts minor   # or patch, major, or an exact version such as 1.0.0-rc.1
git push origin HEAD v0.2.0
```

The script sets the version in the crate and the web package, dates the changelog section, commits and tags. The
pushed tag builds the binaries and images and publishes the GitHub release with that section as its notes.
Pre-releases (`-rc.1`) never move `latest`.

## Built with

Rust (axum, tokio, rusqlite, rustls), React, TypeScript, Tailwind CSS, Vite, TanStack Router and Query, Zustand,
Mediabunny.

## License

[AGPL-3.0](LICENSE)
