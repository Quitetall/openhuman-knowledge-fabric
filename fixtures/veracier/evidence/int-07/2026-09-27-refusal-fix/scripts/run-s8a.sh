#!/usr/bin/env bash
# S8a: marc through the withdrawn (so undeclared) agent client. The token is exchanged once by
# exchange-agent-token.py into a 0600 file, LAMU's kf_source.py runs with it (no --before-sources:
# an undeclared agent's token cannot compile anything), then KF's rows for the window are dumped.
#   run-s8a.sh <agent client id>      Env as run-scenario.sh.
set -uo pipefail
export PGPASSWORD=dev-only-not-a-secret   # the fixture database's public development credential
here="$(cd "$(dirname "$0")" && pwd)"; name=S8a-agent-undeclared; agent="$1"
tok="$SECRETS/$name.tok"; out="$RUNS/$name"; dest="$PACK/$name"; mkdir -p "$dest"
python3 "$here/exchange-agent-token.py" marc.lefevre "$tok" "$agent" > "$dest/exchange.log" 2>&1 || { echo "exchange failed"; exit 1; }
db='postgres://kf_owner@localhost:15432/kf?sslmode=disable'
start="$(psql "$db" -XtAc 'select now()')"
(cd "$HARNESS_DIR" && python3 kf_source.py --lamu "$LAMU_BIN" --llama-server "$LLAMA_SERVER" --model "$MODEL" \
   --kf-url http://127.0.0.1:4100 --token-file "$tok" --organization "$ORG" --acting-role "$MARC" \
   --classification restricted --output "$out" --query "$Q2" --limit 1 --expect sources:access_denied) \
   > "$dest/harness.stdout" 2> "$dest/harness.stderr"
rc=$?; echo "$rc" > "$dest/harness.exit"
end="$(psql "$db" -XtAc 'select now()')"
rm -f "$tok" "$tok.person"
"$here/kf-dump.sh" "$start" "$end" "$dest/kf-rows.csv"
cp "$out/receipt.json" "$dest/"
echo "$name exit=$rc window=$start..$end"
