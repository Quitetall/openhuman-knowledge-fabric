#!/usr/bin/env bash
# Actual dispatcher with PID 1 credential mounts; every endpoint is a public fixture.
set -euo pipefail
release="$1"
event="$2"
plant="$3"
[[ "$EUID" -ne 0 && "$(ulimit -c)" == 0 ]] || exit 80
IFS=: read -r hierarchy controllers cgroup < /proc/self/cgroup
[[ "$hierarchy" == 0 && -z "$controllers" && "$cgroup" == /* && "$cgroup" != *..* ]] || exit 81
[[ "$(< "/sys/fs/cgroup$cgroup/memory.swap.max")" == 0 ]] || exit 82
[[ "$(stat -c '%u:%a' "$RUNTIME_DIRECTORY")" == "$EUID:700" ]] || exit 83
[[ "$(stat -f -c '%t' "$RUNTIME_DIRECTORY")" == 1021994 ]] || exit 84
[[ "$(wc -l < /proc/swaps)" -eq 1 ]] || exit 85
if [[ "$plant" == inherited-pgpass ]]; then
  export PGPASSFILE="$RUNTIME_DIRECTORY/inherited-password"
fi
status=0
/usr/bin/bash "$release/scripts/alert-dispatch.sh" "$event" kf-public-fixture.service \
  > "$RUNTIME_DIRECTORY/output" 2> "$RUNTIME_DIRECTORY/error" || status=$?
if [[ "$plant" == valid ]]; then
  [[ "$status" == 0 && "$(< "$RUNTIME_DIRECTORY/curl-called")" == "$event" ]] || {
    /usr/bin/cat "$RUNTIME_DIRECTORY/error" >&2
    exit 86
  }
  [[ ! -s "$RUNTIME_DIRECTORY/output" ]] || exit 87
else
  [[ "$status" != 0 && ! -e "$RUNTIME_DIRECTORY/curl-called" ]] || exit 88
  case "$plant" in
    ordinary-custody) /usr/bin/grep -q 'is mode 440' "$RUNTIME_DIRECTORY/error" ;;
    missing-tmpdir) /usr/bin/grep -q 'private tmpfs TMPDIR' "$RUNTIME_DIRECTORY/error" ;;
    inherited-pgpass) /usr/bin/grep -q 'inherited PGPASSFILE' "$RUNTIME_DIRECTORY/error" ;;
    invalid-url) /usr/bin/grep -q 'https:// URL' "$RUNTIME_DIRECTORY/error" ;;
    *) /usr/bin/grep -q 'credential custody unavailable' "$RUNTIME_DIRECTORY/error" ;;
  esac
fi
[[ -z "$(/usr/bin/find "$RUNTIME_DIRECTORY" -maxdepth 1 -type f -name 'tmp.*' -print -quit)" ]] || exit 89
printf 'PASS: native alert %s %s; no credential output or leftover password file\n' "$event" "$plant"
