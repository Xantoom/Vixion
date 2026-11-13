# syntax=docker/dockerfile:1.10
#
# Vixion in a container: one static binary on a distroless base (about 25 MB).
#
#   docker build -t vixion .
#
# Base images are pinned by digest, and Dependabot proposes their updates.

FROM oven/bun:1.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# rust-toolchain.toml decides the compiler: should it differ from this image's, rustup fetches it.
FROM rust:1.100-alpine@sha256:de1e0058543a81ed7b046629167db587c67a94bdf37cce14eb27f0ec83baaffb AS server
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock rustfmt.toml rust-toolchain.toml ./
COPY server/ server/
COPY --from=web /src/web/dist web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/vixion /vixion
# Owned by the image's user, so that named volumes start writable.
RUN mkdir -p /volumes/config /volumes/recordings

FROM gcr.io/distroless/static-debian13:nonroot@sha256:aafe993665bf6200db38a02c11a9351e782a84b6a45e7f33b6695638c88e3931
LABEL org.opencontainers.image.title="Vixion" \
      org.opencontainers.image.description="Records the Twitch channels you follow, chat included, and plays them back in your browser." \
      org.opencontainers.image.source="https://github.com/Xantoom/Vixion" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=server /vixion /usr/local/bin/vixion
COPY --from=server --chown=65532:65532 /volumes/ /
ENV VIXION_DATA_DIR=/config VIXION_RECORDINGS_DIR=/recordings
VOLUME /config /recordings
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["vixion", "healthcheck"]
ENTRYPOINT ["vixion"]
