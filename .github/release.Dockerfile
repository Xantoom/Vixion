# Release images, from the static binaries the release workflow built (see Dockerfile for the
# image built from source).
# The volume folders, owned by the image's user so that named volumes start writable.
FROM --platform=$BUILDPLATFORM busybox:1.37 AS volumes
RUN mkdir -p /volumes/config /volumes/recordings

FROM gcr.io/distroless/static-debian12:nonroot
ARG TARGETARCH
COPY out/${TARGETARCH}/vixion /usr/local/bin/vixion
COPY --from=volumes --chown=65532:65532 /volumes/ /
ENV VIXION_DATA_DIR=/config VIXION_RECORDINGS_DIR=/recordings
VOLUME /config /recordings
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["vixion", "healthcheck"]
ENTRYPOINT ["vixion"]

