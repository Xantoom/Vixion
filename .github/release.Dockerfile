# Release images, from the static binaries the release workflow built (see Dockerfile for the
# image built from source).
# The volume folders, owned by the image's user so that named volumes start writable.
FROM --platform=$BUILDPLATFORM busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec AS volumes
RUN mkdir -p /volumes/config /volumes/recordings

FROM gcr.io/distroless/static-debian13:nonroot@sha256:aafe993665bf6200db38a02c11a9351e782a84b6a45e7f33b6695638c88e3931
LABEL org.opencontainers.image.title="Vixion" \
      org.opencontainers.image.description="Records the Twitch channels you follow, chat included, and plays them back in your browser." \
      org.opencontainers.image.source="https://github.com/Xantoom/Vixion" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ARG TARGETARCH
COPY out/${TARGETARCH}/vixion /usr/local/bin/vixion
COPY --from=volumes --chown=65532:65532 /volumes/ /
ENV VIXION_DATA_DIR=/config VIXION_RECORDINGS_DIR=/recordings
VOLUME /config /recordings
EXPOSE 6280 6281
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["vixion", "healthcheck"]
ENTRYPOINT ["vixion"]

