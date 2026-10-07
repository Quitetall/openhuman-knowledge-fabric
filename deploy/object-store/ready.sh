#!/bin/sh
#
# Is the object store ready to SERVE what it holds, not merely listening? Exit 0 when it is.
#
#   ready.sh [--wait SECONDS] [data-dir]     (data-dir default /data, the container's)
#
# The S3 gateway answers /healthz as soon as it listens. After a restart (or a restore of a copied
# data directory) the volume server has not yet told the master which volumes it holds, and for
# those seconds every read answers 500 InternalError ("volume id N not found"). So ready means
# three things: the gateway answers; the master answers; and the master knows of every volume file
# in the data directory. A fresh store has none, and is ready as soon as both answer.
#
# --wait retries for up to SECONDS (kf-objects.service's ExecStartPost, so units ordered after
# it start against a store that can serve). Ports are SeaweedFS's `weed server` defaults (S3 8333,
# master 9333) on loopback, which is where docker-compose.yml and kf-objects.service bind them.
# Uses curl where there is one (a host) and busybox wget otherwise (the container).

set -eu
wait_seconds=0
if [ "${1:-}" = --wait ]; then
  wait_seconds="${2:?--wait needs a number of seconds}"
  shift 2
fi
data="${1:-/data}"
s3="${KF_OBJECTS_S3_PORT:-8333}"
master="${KF_OBJECTS_MASTER_PORT:-9333}"

get() {
  if command -v curl >/dev/null 2>&1; then
    curl --silent --fail --max-time 5 "$1"
  else
    wget -q -T 5 -O - "$1"
  fi
}

ready() {
  get "http://127.0.0.1:$s3/healthz" >/dev/null || return 1
  status="$(get "http://127.0.0.1:$master/dir/status")" || return 1
  on_disk=0
  for file in "$data"/*.dat; do
    [ -e "$file" ] && on_disk=$((on_disk + 1))
  done
  known=0
  for count in $(printf '%s' "$status" | grep -o '"Volumes":[0-9]*' | cut -d: -f2); do
    known=$((known + count))
  done
  [ "$known" -ge "$on_disk" ]
}

deadline=$(($(date +%s) + wait_seconds))
until ready; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    [ "$wait_seconds" = 0 ] || echo "ready.sh: the object store did not become ready in ${wait_seconds}s" >&2
    exit 1
  fi
  sleep 1
done
