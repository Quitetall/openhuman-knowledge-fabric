#!/usr/bin/env bash
# One act by the Records Office persona (elodie.marchetti), who recorded the fixture's grants:
#   records-office-act.sh <action> <target id> <payload json> <reason>
# Mints her token into a 0600 file under $SECRETS, POSTs /actions/<action>, deletes the token.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
action="$1"; target="$2"; payload="$3"; reason="$4"
tok="$SECRETS/records-office.$$.tok"
trap 'rm -f "$tok"' EXIT
node "$here/mint.mjs" elodie.marchetti "$tok"
body="$(python3 -c 'import json,sys; print(json.dumps({"targetIds":[sys.argv[1]],"idempotencyKey":sys.argv[2],"reason":sys.argv[3],"payload":json.loads(sys.argv[4])}))' \
  "$target" "int07-$action-$(date +%s%N)" "$reason" "$payload")"
node "$here/kf-act.mjs" "$tok" "$ORG" "$ELODIE" restricted POST "/actions/$action" "$body"
