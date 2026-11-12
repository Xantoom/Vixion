# Release images, from the static binaries the release workflow built (see Dockerfile for the
# image built from source).
FROM gcr.io/distroless/static-debian12:nonroot
ARG TARGETARCH
COPY out/${TARGETARCH}/vixion /usr/local/bin/vixion
ENV VIXION_DATA_DIR=/data
VOLUME /data
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["vixion", "healthcheck"]
ENTRYPOINT ["vixion"]

