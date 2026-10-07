#!/bin/sh
#
# Is the object store ready to SERVE what it holds, not merely listening? Exit 0 when it is.
#
#   ready.sh [data-dir]     (default /data; run where the store runs: its container, or its host)
#
# The S3 gateway answers /healthz as soon as it listens. After a restart (or a restore of a copied
# /data) the volume server has not yet told the master which volumes it holds, and for those
# seconds every read answers 500 InternalError ("volume id N not found"). So ready means three
# things: the gateway answers; the master answers; and the master knows of every volume file in
# the data directory. A fresh store has none, and is ready as soon as both answer.
#
# Ports are SeaweedFS's defaults for `weed server` (s3 8333, master 9333) on loopback, which is
# where docker-compose.yml and the kf-objects unit bind them.

set -eu
data="${1:-/data}"
s3="${KF_OBJECTS_S3_PORT:-8333}"
master="${KF_OBJECTS_MASTER_PORT:-9333}"

wget -q -O /dev/null "http://127.0.0.1:$s3/healthz"
status="$(wget -q -O - "http://127.0.0.1:$master/dir/status")"
on_disk=0
for file in "$data"/*.dat; do
  [ -e "$file" ] && on_disk=$((on_disk + 1))
done
known=0
for count in $(printf '%s' "$status" | grep -o '"Volumes":[0-9]*' | cut -d: -f2); do
  known=$((known + count))
done
[ "$known" -ge "$on_disk" ]
