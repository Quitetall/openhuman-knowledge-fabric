# The MinIO server and client the OW-WAR-0111 preservation test restores with, BUILT FROM SOURCE
# because nothing else can be pulled any more. See build.sh beside this file for why and how.
#
#   docker build --target minio -t kf-fixture/minio:<release> tests/fixtures/minio-image
#   docker build --target mc    -t kf-fixture/mc:<release>    tests/fixtures/minio-image
#
# Every input is pinned: the builder and runtime images by digest, each source by commit, and
# each commit is checked against the release tag it is supposed to be, so a moved tag or a
# replaced repository fails the build instead of building something else. The version stamping
# is MinIO's own release build's (MINIO_RELEASE=RELEASE, the release timestamp as the version),
# and each stage asserts `--version` reads exactly as the published binary's did.

# golang:1.24-bookworm on 2026-09-26. go.mod says `go 1.24.0` (server) and `go 1.23.0` (client).
ARG GOLANG=docker.io/library/golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac
# distroless/static-debian12 on 2026-09-26: CA certificates, /tmp, and nothing to execute but the
# one binary. The fixture drives the server only through `docker create|start|stop|cp|rm` and S3.
ARG RUNTIME=gcr.io/distroless/static-debian12@sha256:d75cdd72874d4790092fcb1b058493ecf6bb5bf2b2b897045b00ff01d91843f2

ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z
ARG MINIO_COMMIT=07c3a429bfed433e49018cb0f78a52145d4bedeb
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096

FROM ${GOLANG} AS source
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
# build-release <repository> <release tag> <pinned commit> <binary>: fetch, verify, build to /out.
COPY build-release.sh /usr/local/bin/build-release

FROM source AS minio-build
ARG MINIO_RELEASE
ARG MINIO_COMMIT
RUN build-release https://github.com/minio/minio.git "${MINIO_RELEASE}" "${MINIO_COMMIT}" minio

FROM source AS mc-build
ARG MC_RELEASE
ARG MC_COMMIT
RUN build-release https://github.com/minio/mc.git "${MC_RELEASE}" "${MC_COMMIT}" mc

FROM ${RUNTIME} AS mc
ARG MC_RELEASE
ARG MC_COMMIT
LABEL org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.revision="${MC_COMMIT}" \
      org.opencontainers.image.version="${MC_RELEASE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV MC_CONFIG_DIR=/tmp/.mc
COPY --from=mc-build /out/mc /usr/bin/mc
ENTRYPOINT ["/usr/bin/mc"]

FROM ${RUNTIME} AS minio
ARG MINIO_RELEASE
ARG MINIO_COMMIT
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="${MINIO_COMMIT}" \
      org.opencontainers.image.version="${MINIO_RELEASE}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=minio-build /out/minio /usr/bin/minio
EXPOSE 9000
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/minio"]
