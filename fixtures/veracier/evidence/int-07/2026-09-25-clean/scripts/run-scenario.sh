#!/usr/bin/env bash
# One INT-07 scenario: keep the persona's token fresh, run LAMU's kf_source.py from its own
# directory, then dump KF's rows for the run window and copy the text-free artifacts to the pack.
#   run-scenario.sh <name> <username> <assignment> <classification> [kf_source.py args...]
# BEFORE_CLS (optional): the classification the persona compiles their master record at, when the
# scenario asks LAMU for another one (S2 asks above clearance; the person refreshes at their own).
# Env: LAMU_BIN LLAMA_SERVER MODEL HARNESS_DIR SECRETS RUNS PACK ORG (paths only; no secrets).
set -uo pipefail
export PGPASSWORD=dev-only-not-a-secret   # the fixture database's public development credential
name="$1"; user="$2"; role="$3"; cls="$4"; shift 4
here="$(cd "$(dirname "$0")" && pwd)"
tok="$SECRETS/$name.tok"
out="$RUNS/$name"
dest="$PACK/$name"
mkdir -p "$dest"
node "$here/mint.mjs" "$user" "$tok" --loop 150 > "$RUNS/$name.mint.log" 2>&1 &
minter=$!
until [ -s "$tok" ]; do sleep 0.2; kill -0 $minter 2>/dev/null || { echo "mint failed"; exit 1; }; done
start="$(psql 'postgres://kf_owner@localhost:15432/kf?sslmode=disable' -XtAc 'select now()' 2>/dev/null)"
[ -n "$start" ] || start="$(date -u +%Y-%m-%dT%H:%M:%S.%6NZ)"
(cd "$HARNESS_DIR" && python3 kf_source.py --lamu "$LAMU_BIN" --llama-server "$LLAMA_SERVER" --model "$MODEL" \
   --kf-url http://127.0.0.1:4100 --token-file "$tok" --organization "$ORG" --acting-role "$role" \
   --classification "$cls" --output "$out" \
   --before-sources node "$here/kf-act.mjs" "$tok" "$ORG" "$role" "${BEFORE_CLS:-$cls}" POST /master-record/compile \
       "{\"idempotencyKey\":\"int07-$name-$(date +%s%N)\",\"reason\":\"INT-07 $name: the person's own master-record compile before LAMU's source lookup\"}" \
   "$@") > "$dest/harness.stdout" 2> "$dest/harness.stderr"
rc=$?
echo "$rc" > "$dest/harness.exit"
end="$(psql 'postgres://kf_owner@localhost:15432/kf?sslmode=disable' -XtAc 'select now()' 2>/dev/null)"
kill $minter 2>/dev/null; wait $minter 2>/dev/null
rm -f "$tok"; find "$SECRETS" -name "$name.tok.tmp-*" -delete
"$here/kf-dump.sh" "$start" "$end" "$dest/kf-rows.csv"
for f in receipt.json compiled.json before-sources.log; do [ -f "$out/$f" ] && cp "$out/$f" "$dest/"; done
echo "$name exit=$rc window=$start..$end"
