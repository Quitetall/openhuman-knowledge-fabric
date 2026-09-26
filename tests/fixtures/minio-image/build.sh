#!/usr/bin/env bash
# Build the MinIO server and client images tests/database/preservation-minio.ts runs.
#
#   tests/fixtures/minio-image/build.sh           # build whichever image is missing
#   tests/fixtures/minio-image/build.sh --force   # rebuild both
#   tests/fixtures/minio-image/build.sh --save F  # then `docker save` both into F (CI's cache)
#
# WHY FROM SOURCE. The fixture pinned quay.io/minio/minio@sha256:14cea493… and
# quay.io/minio/mc@sha256:a7fe349e…, and on 2026-09-26 neither can be pulled from anywhere:
# MinIO archived its community edition, Docker Hub's minio/minio answers 404, Quay has no such
# manifest, and dl.min.io answers every archived binary with "410 Gone". Hosts that pulled them
# before still have them cached, which is why the test passed on a workstation and failed on a
# clean CI runner with "unauthorized: access to the requested resource is not authorized".
#
# The source is still public (github.com/minio/minio and minio/mc, archived read-only), so the
# same releases are built here from the same commits. The binaries are not byte-identical to
# the lost ones (a different Go patch release compiles them); `--version` is, and the build
# fails unless it is. The Dockerfile pins every other input.
#
# The tags below are the ones preservation-minio.ts runs; change them together.
set -euo pipefail

MINIO_IMAGE=kf-fixture/minio:RELEASE.2025-09-07T16-13-09Z
MC_IMAGE=kf-fixture/mc:RELEASE.2025-08-13T08-35-41Z
context="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

force=0
save=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --save)
      [ "$#" -ge 2 ] || { echo "--save needs a file" >&2; exit 2; }
      save="$2"
      shift
      ;;
    *) echo "usage: $0 [--force] [--save FILE]" >&2; exit 2 ;;
  esac
  shift
done

build() {
  local target="$1" image="$2"
  if [ "${force}" = 0 ] && docker image inspect "${image}" >/dev/null 2>&1; then
    echo "${image}: present"
    return
  fi
  docker build --target "${target}" --tag "${image}" "${context}"
  docker run --rm "${image}" --version
}

build minio "${MINIO_IMAGE}"
build mc "${MC_IMAGE}"

if [ -n "${save}" ]; then
  mkdir -p "$(dirname "${save}")"
  docker save --output "${save}" "${MINIO_IMAGE}" "${MC_IMAGE}"
fi
