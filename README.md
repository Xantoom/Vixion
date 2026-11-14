<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg" />
  <img alt="Vixion" src=".github/logo-light.svg" width="72" height="72" />
</picture>

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
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    ports:
      - "8080:8080"
    volumes:
      - ./config:/config
      - ./recordings:/recordings
    environment:
      VIXION_TWITCH_TOKEN: ""
```

```bash
mkdir config recordings
docker compose up -d
```

Open `http://your-server:8080` and create the administrator account with the setup code from the log
(`docker logs vixion`), so that nobody else on the network can claim the install first. Then search for a channel and
add it: it is recorded whenever it goes live, starting right away if it already is.

<details>
<summary>With <code>docker run</code></summary>

```bash
mkdir config recordings
docker run -d --name vixion --restart unless-stopped --stop-timeout 30 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 -p 8080:8080 -v ./config:/config -v ./recordings:/recordings \
  -e VIXION_TWITCH_TOKEN="" \
  ghcr.io/xantoom/vixion:latest
```

</details>

Images exist for x86-64 and arm64. Create both folders before the first start so that they belong to you rather than
to root. `read_only`, `cap_drop` and `no-new-privileges` are optional: Vixion writes only to its two folders and needs
no privileges, so they cost nothing and contain the damage should it ever be compromised.

> [!WARNING]
> Don't send the video through a Cloudflare Tunnel: Cloudflare's terms forbid carrying video over it.

## Parameters

| Parameter                       | Function                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `-p 8080`                       | The web interface and its API: one server, one port                              |
| `-v /config`                    | Database, keys and certificates: a few megabytes, worth backing up               |
| `-v /recordings`                | The recordings: put it on a large disk                                           |
| `--user 1000:1000`              | The owner of both folders on the host (`id -u`, `id -g`)                         |
| `-e VIXION_TWITCH_TOKEN`        | A Twitch account's token: no ads, best quality (see below). Recommended          |
| `-e VIXION_TWITCH_TOKEN_FILE`   | The same, read from a file, for Docker secrets                                   |
| `-e VIXION_TRUST_PROXY`         | `true` behind a reverse proxy or Cloudflare, so sign-in limits see real addresses |
| `-e VIXION_LOG`                 | `error`, `warn`, `info` (default) or `debug`                                     |

Everything else (retention, H.264 only, chat, alerts) is in *Administration → Settings*. Twitch is checked
automatically, every 30 seconds with a few channels and less often with hundreds, within what Twitch allows.

## Video outside the tunnel

When the interface sits behind a Cloudflare Tunnel, the video can't go through it. Vixion can serve it itself, over
HTTPS on its own port, with a certificate it gets from Let's Encrypt through Cloudflare's DNS:

```yaml
    network_mode: host # instead of ports, for UPnP
    environment:
      VIXION_MEDIA_MODE: https
      VIXION_MEDIA_DOMAIN: vixion-media.example.com
      VIXION_CLOUDFLARE_API_TOKEN: "" # Zone: DNS: Edit on that domain
      VIXION_MEDIA_PUBLIC_PORT: 8443  # the port seen from the internet
      VIXION_DDNS: true               # keeps the domain on your public address
      VIXION_UPNP: true               # asks the router to forward that port, as Plex does
```

With `VIXION_UPNP`, the router forwards `VIXION_MEDIA_PUBLIC_PORT` to the media port (8443) of this machine, renews it
every twenty minutes and closes it when Vixion stops. UPnP must be on in the router, and the container on the host
network so it can find it. Without UPnP, forward the port by hand. *Administration → Logs* says if the router refused.

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

A variable shows in `docker inspect`. To keep the token out of it, put it in a file and pass it as a secret:

```yaml
services:
  vixion:
    # …
    environment:
      VIXION_TWITCH_TOKEN_FILE: /run/secrets/twitch_token
    secrets: [twitch_token]
secrets:
  twitch_token:
    file: ./twitch_token.txt
```

## Updating

```bash
docker compose pull && docker compose up -d
```

Recordings in progress close cleanly and continue as a new part once the container is back. Pin the minor line
(`ghcr.io/xantoom/vixion:0.2`) to get fixes without surprises; [CHANGELOG.md](CHANGELOG.md) lists every change.

## Troubleshooting

- **Logs**: `docker logs -f vixion`, or *Administration → Logs* in the interface.
- **Forgotten password**: `docker exec -it vixion vixion reset-password <user>`, then type the new one.
- **Permission denied**: a folder belongs to another user; `sudo chown -R 1000:1000 config recordings` or change
  `user`.

## Without Docker

Static Linux binaries (x86-64, arm64) are attached to each [release](https://github.com/Xantoom/Vixion/releases):

```bash
VIXION_DATA_DIR=/var/lib/vixion VIXION_RECORDINGS_DIR=/srv/recordings VIXION_TWITCH_TOKEN=... ./vixion
```

Without `VIXION_RECORDINGS_DIR`, recordings go to `streams` inside the data folder.

Each release lists the binaries' checksums in `SHA256SUMS` (`sha256sum -c SHA256SUMS --ignore-missing`), and
`gh attestation verify vixion-linux-x86_64 --repo Xantoom/Vixion` proves a binary, or an image, was built by this
repository's release workflow.

`--twitch-token <token>` also works, but shows in the process list.

## Development

Needs [Bun](https://bun.sh) 1.4 and [rustup](https://rustup.rs), which installs the Rust version
`rust-toolchain.toml` names.

```bash
cd web && bun install && bun run build && cd ..
cargo run -- serve
```

`cd web && bun run dev` serves the interface with hot reload on port 5173, against the server on 8080.

```bash
cargo fmt --check && cargo clippy --all-targets && cargo test --profile ci
cd web && bun run fmt:check && bun run typecheck && bun run lint
```

## Built with

Rust (axum, tokio, rusqlite, rustls), React, TypeScript, Tailwind CSS, Vite, TanStack Router and Query, Zustand,
Mediabunny.

## License

[AGPL-3.0](LICENSE)
