# syntax=docker/dockerfile:1.10
#
# Vixion in a container: one static binary on a distroless base (about 25 MB).
#
#   docker build -t vixion .

FROM oven/bun:1.4-alpine AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM rust:1-alpine AS server
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock rustfmt.toml ./
COPY server/ server/
COPY --from=web /src/web/dist web/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/vixion /vixion
# Owned by the image's user, so that named volumes start writable.
RUN mkdir -p /volumes/config /volumes/recordings

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /vixion /usr/local/bin/vixion
COPY --from=server --chown=65532:65532 /volumes/ /
ENV VIXION_DATA_DIR=/config VIXION_RECORDINGS_DIR=/recordings
VOLUME /config /recordings
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["vixion", "healthcheck"]
ENTRYPOINT ["vixion"]
