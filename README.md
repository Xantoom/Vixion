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
  out quiet talk and loud moments. Reopens each recording where you left it. Downloads the video, the chat (JSON),
  or the chat as subtitles (ASS).
- **Keeps the disk in check**: recordings expire after 14 days unless kept forever; when space runs low the oldest go
  first. Statistics show what each streamer takes.
- **Several people**: administrators, users and custom roles, with permissions per role and per person.
- **Small**: one static binary of a few megabytes, a few megabytes of memory at rest. Logs, alerts, and webhooks
  (Discord, ntfy or JSON) when something needs attention.

English and French. Phones, tablets, desktops and TVs.

Vixion is not affiliated with Twitch. Record only what you're allowed to keep.

## Quick start

Vixion runs as one container. Create a folder, put this `compose.yaml` in it, and start it:

```yaml
services:
  vixion:
    image: ghcr.io/xantoom/vixion:latest
    container_name: vixion
    restart: unless-stopped
    user: "1000:1000"
    stop_grace_period: 30s
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    environment:
      VIXION_TWITCH_TOKEN: ""
```

```bash
mkdir data
docker compose up -d
```

Open `http://your-server:8080`, create the administrator account, then search for a channel and add it. It is
recorded whenever it goes live, starting right away if it already is.

<details>
<summary>With <code>docker run</code></summary>

```bash
mkdir data
docker run -d --name vixion --restart unless-stopped --stop-timeout 30 \
  --user 1000:1000 -p 8080:8080 -v ./data:/data \
  -e VIXION_TWITCH_TOKEN="" \
  ghcr.io/xantoom/vixion:latest
```

</details>

Images exist for x86-64 and arm64. Create `data` before the first start so that it belongs to you rather than to
root.

## Parameters

| Parameter                       | Function                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `-p 8080`                       | The web interface                                                                |
| `-v /data`                      | Database, recordings and keys. Put it on the disk that holds the recordings      |
| `--user 1000:1000`              | The owner of the data folder on the host (`id -u`, `id -g`)                       |
| `-e VIXION_TWITCH_TOKEN`        | A Twitch account's token: no ads, best quality (see below). Recommended          |
| `-e VIXION_TWITCH_TOKEN_FILE`   | The same, read from a file, for Docker secrets                                   |
| `-e VIXION_LOG`                 | `error`, `warn`, `info` (default) or `debug`                                     |

Everything else (retention, H.264 only, chat, alerts) is in *Administration → Settings*. Twitch is checked
automatically, every 30 seconds with a few channels and less often with hundreds, within what Twitch allows.

## Twitch token

Without a token Vixion records anyway: it skips ads by switching players, which leaves a few seconds missing where each
ad was, and may not get the best qualities (1440p, HEVC). With the token of an account that has **Turbo**, Twitch
sends no ads at all and the recordings are complete; this is the recommended setup. A subscription to a channel
removes ads on that channel only.

To get it, on a computer:

1. Sign in on [twitch.tv](https://www.twitch.tv) with that account.
2. Open the developer tools (`F12`), then *Application* (Chrome, Edge) or *Storage* (Firefox) → *Cookies* →
   `https://www.twitch.tv`.
3. Copy the value of `auth-token`, 30 letters and digits.

Put it in `VIXION_TWITCH_TOKEN` and restart the container. *Settings → Twitch* shows it masked, with buttons to reveal
and copy it. Signing out of twitch.tv in that browser invalidates the token: close the tab instead, or use a private
window to take it. Vixion only sends it to Twitch, and raises an alert if Twitch refuses it.

## Updating

```bash
docker compose pull && docker compose up -d
```

Recordings in progress close cleanly and continue as a new part once the container is back. Pin the minor line (`ghcr.io/xantoom/vixion:0.2`) to
get fixes without surprises; see [Versions](#versions).

## Troubleshooting

- **Logs**: `docker logs -f vixion`, or *Administration → Logs* in the interface.
- **Forgotten password**: `docker exec vixion vixion reset-password <user> <new-password>`.
- **Permission denied on /data**: the folder belongs to another user; `sudo chown -R 1000:1000 data` or change `user`.

## Video outside a Cloudflare Tunnel

A Cloudflare Tunnel in front of the interface is fine for pages, but its terms don't allow carrying video, and it
would slow it down. Like Plex, Vixion can serve the video on its own port:

| `VIXION_MEDIA_MODE` | Video is served                          | Use it when                                               |
| ------------------- | ---------------------------------------- | --------------------------------------------------------- |
| `same` (default)    | by the interface, under `/media`         | on a local network, or behind your own reverse proxy      |
| `https`             | on port 8443, with its own certificate   | the interface is behind a Cloudflare Tunnel               |
| `http`              | on port 8443, plain HTTP                 | your own proxy (Caddy, Traefik) handles TLS for that port |

For `https`, give Vixion a domain and a Cloudflare API token with *Zone → Zone → Read* and *Zone → DNS → Edit*. It
gets a Let's Encrypt certificate by DNS challenge and renews it; with `VIXION_DDNS=true` it also keeps the domain's A
record on your public address. Publish port 8443 and forward it on your router:

```yaml
    ports:
      - "8080:8080"
      - "8443:8443"
    environment:
      VIXION_MEDIA_MODE: https
      VIXION_MEDIA_DOMAIN: media.example.com
      VIXION_CLOUDFLARE_API_TOKEN: your-cloudflare-token
      VIXION_DDNS: "true"
```

Video links are signed and expire after 12 hours: nobody can watch without signing in first.

<details>
<summary>All video variables</summary>

| Variable                      | Default        | Function                                                    |
| ----------------------------- | -------------- | ----------------------------------------------------------- |
| `VIXION_MEDIA_MODE`           | `same`         | `same`, `https` or `http`                                   |
| `VIXION_MEDIA_DOMAIN`         |                | The video domain, in `https` mode                           |
| `VIXION_MEDIA_PUBLIC_PORT`    | 8443           | The port browsers use, when the router forwards another one |
| `VIXION_MEDIA_PUBLIC_URL`     |                | The video origin browsers use (required in `http` mode)     |
| `VIXION_CLOUDFLARE_API_TOKEN` |                | Let's Encrypt by DNS challenge, and DDNS                    |
| `VIXION_ACME_EMAIL`           |                | Contact for Let's Encrypt                                   |
| `VIXION_ACME_STAGING`         | `false`        | Let's Encrypt's staging server, while testing               |
| `VIXION_ACME_DIRECTORY`       | Let's Encrypt  | Another ACME authority's directory URL                      |
| `VIXION_TLS_CERT`, `_KEY`     |                | Your own certificate files instead of Let's Encrypt         |
| `VIXION_DDNS`                 | `false`        | Keep the video domain's A record on the public address      |
| `VIXION_HTTP_ADDR`            | `0.0.0.0:8080` | Where the interface listens                                 |
| `VIXION_MEDIA_ADDR`           | `0.0.0.0:8443` | Where the video listens                                     |
| `VIXION_LOG_FORMAT`           | text           | `json` for log collectors                                   |

</details>

## Without Docker

Static Linux binaries (x86-64, arm64) are attached to each [release](https://github.com/Xantoom/Vixion/releases):

```bash
VIXION_DATA_DIR=/var/lib/vixion VIXION_TWITCH_TOKEN=... ./vixion
```

`--twitch-token <token>` also works, but shows in the process list.

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
