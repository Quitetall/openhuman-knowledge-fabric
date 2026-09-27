#!/usr/bin/env bash
# One live injection probe with its KF rows for the window: probe.sh <dir> <injection-probe args...>
set -uo pipefail
export PGPASSWORD=dev-only-not-a-secret   # the fixture database's public development credential
here="$(cd "$(dirname "$0")" && pwd)"; dir="$1"; shift
mkdir -p "$dir"
db='postgres://kf_owner@localhost:15432/kf?sslmode=disable'
start="$(psql "$db" -XtAc 'select now()')"
node "$here/injection-probe.mjs" "$@" > "$dir/probe.out" 2> "$dir/probe.err"; echo "$?" > "$dir/probe.exit"
sleep 1
end="$(psql "$db" -XtAc 'select now()')"
"$here/kf-dump.sh" "$start" "$end" "$dir/kf-rows.csv"
grep '"refused"' "${KF_VERACIER_STATE:-$HOME/.local/state/kf-veracier}/logs/attestor.log" | tail -1 > "$dir/attestor-refused.jsonl"   # the probe's own refusal is the last one
cat "$dir/probe.out"; grep -A3 identification_refusal "$dir/kf-rows.csv"
