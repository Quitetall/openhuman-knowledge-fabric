#!/bin/sh
# build-release <repository> <release tag> <pinned commit> <binary>
#
# Runs INSIDE the Dockerfile's build stage. Fetches exactly one release tag, refuses it unless it
# names the pinned commit, builds with MinIO's own release stamping, and refuses the binary unless
# `--version` reads as the published one did: "<binary> version <release> (commit-id=<commit>)".
set -eu
repository="$1" release="$2" commit="$3" binary="$4"

mkdir -p /src
cd /src
git init --quiet .
git remote add origin "${repository}"
git fetch --quiet --depth 1 origin "refs/tags/${release}:refs/tags/${release}"
actual="$(git rev-parse "${release}^{commit}")"
if [ "${actual}" != "${commit}" ]; then
  echo "${repository} ${release} is ${actual}, pinned ${commit}" >&2
  exit 1
fi
git checkout --quiet "${commit}"

# RELEASE.2025-09-07T16-13-09Z -> 2025-09-07T16:13:09Z, the form gen-ldflags.go parses.
version="$(echo "${release#RELEASE.}" | sed -E 's/T([0-9]+)-([0-9]+)-([0-9]+)Z$/T\1:\2:\3Z/')"
# The prefix variable is MINIO_RELEASE in the server and MC_RELEASE in the client, and the
# Dockerfile's build arguments of those names reach this script's environment holding the full
# tag, so both are set to the literal prefix here, and the hotfix suffixes emptied.
ldflags="$(MINIO_RELEASE=RELEASE MC_RELEASE=RELEASE MINIO_HOTFIX='' MC_HOTFIX='' \
  go run buildscripts/gen-ldflags.go "${version}")"
go build -ldflags "${ldflags}" \
  -o "/out/${binary}" .

"/out/${binary}" --version
"/out/${binary}" --version | head -1 |
  grep -Fx "${binary} version ${release} (commit-id=${commit})"
