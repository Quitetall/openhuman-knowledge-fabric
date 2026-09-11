#!/usr/bin/env bash
#
# Munder Diffin — real workflows through the API, as the people who would do them.
#
# Every step is a request a person's session could make, asserted against the answer the
# model says they should get. A wrong answer is printed and counted; the run does not stop,
# because the second failure is often the one that explains the first. Assumes setup.sh has
# run. Runs ON the host as root (tokens are minted through the realm; lookups bind an org).
#
#   sudo fixtures/munder-diffin/workflow.sh [--release /opt/kf]
#
set -uo pipefail

release='/opt/kf'
[ "${1:-}" = '--release' ] && release="$2"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
login="$here/../../scripts/deploy/login-token.sh"; [ -x "$login" ] || login="$release/scripts/deploy/login-token.sh"
kf() { node "$release/apps/api/dist/cli.js" "$@"; }

set -a; . /etc/kf/api.env; set +a
export DATABASE_OWNER_URL_FILE=/etc/kf/owner/database-url
export DATABASE_OWNER_URL="$(cat /etc/kf/owner/database-url)"
export DATABASE_URL_FILE=/etc/kf/api/database-url
export S3_SECRET_ACCESS_KEY_FILE=/etc/kf/api/s3-secret-access-key
export KF_OIDC_ISSUER="$OIDC_ISSUER" KF_REDIRECT_URI="${KF_REDIRECT_URI:-https://kf.internal/auth/callback}"
export CURL_CA_BUNDLE="${NODE_EXTRA_CA_CERTS:-}" NODE_ENV=production
API="${KF_API_ORIGIN:-https://api.kf.internal}"
secrets=/etc/kf/fixtures/munder-diffin
tokens="$secrets/tokens"; install -d -m 0700 "$tokens"

q() { printf "'%s'" "${1//\'/\'\'}"; }
psql_owner() { psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -X -A -t -q -c "$1"; }
org="$(psql_owner "select coalesce(org.organization_by_name('Munder Diffin Paper Shredding Co.')::text, '')")"
[ -n "$org" ] || { echo "no Munder Diffin organization; run setup.sh first" >&2; exit 1; }
psql_scoped() { psql_owner "select core.set_access_context($(q "$org"), 'restricted'); $1" | tail -n 1; }
person_id() { psql_scoped "select p.id from org.person p where p.organization = $(q "$org") and p.display_name = $(q "$1") order by p.id limit 1"; }
assignment_of() { psql_scoped "select id from org.role_assignment where subject_id = $(q "$1") and scope_id = $(q "$org") and valid_from <= now() and (valid_to is null or valid_to > now()) order by valid_from desc limit 1"; }
artifact_id() { psql_scoped "select id from core.object where organization_id = $(q "$org") and object_type = 'artifact' and title = $(q "$1") order by id limit 1"; }
token_for() { local var="PW_${1//./_}"; KF_LOGIN_PASSWORD="$(grep "^$var=" "$secrets/passwords.env" | cut -d= -f2-)" "$login" "$1" "$tokens/$1" >/dev/null; cat "$tokens/$1"; }

pass=0; fail=0
check() { # check <label> <expected-status> <actual-status> [body]
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok    %-70s %s\n' "$1" "$3"
  else fail=$((fail+1)); printf '  FAIL  %-70s expected %s got %s\n        %s\n' "$1" "$2" "$3" "${4:-}"; fi
}
# as <person-name> <username> <clearance> — sets T, A (assignment), C (clearance), P (person id)
as() { P="$(person_id "$1")"; A="$(assignment_of "$P")"; C="$3"; T="$(token_for "$2")"; }
req() { # req <method> <path> [json-body] -> sets STATUS, BODY
  local m="$1" p="$2" b="${3:-}" out="$secrets/last.json"
  if [ -n "$b" ]; then
    STATUS="$(curl -s -o "$out" -w '%{http_code}' -X "$m" -H "Authorization: Bearer $T" -H "x-kf-organization: $org" -H "x-kf-acting-role: $A" -H "x-kf-classification: $C" -H 'Content-Type: application/json' -d "$b" "$API$p")"
  else
    STATUS="$(curl -s -o "$out" -w '%{http_code}' -X "$m" -H "Authorization: Bearer $T" -H "x-kf-organization: $org" -H "x-kf-acting-role: $A" -H "x-kf-classification: $C" "$API$p")"
  fi
  BODY="$(head -c 300 "$out" | tr '\n' ' ')"
}
act() { # act <action> <target-id> <reason> [payload-json]
  local key; key="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  local payload="${4:-}"
  req POST "/actions/$1" "{\"targetIds\":[\"$2\"],\"idempotencyKey\":\"$key\",\"reason\":\"$3\"$( [ -n "$payload" ] && printf ',"payload":%s' "$payload")}"
}
members() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["measurements"]["memberCount"])' "$secrets/last.json"; }
titles() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(" ".join(sorted(m.get("title","") for s in d["sections"] for m in s["members"] if m["objectType"]=="artifact")))' "$secrets/last.json"; }

pricing="$(artifact_id pricing-and-margin-sheet-q3-2026.md)"
agreement="$(artifact_id vance-refrigeration-service-agreement.md)"
brochure="$(artifact_id marketing-brochure-2026.md)"
board="$(artifact_id board-decision-acquisition-of-scranton-shred.md)"
jim="$(person_id 'Jim Miller')"; ryan="$(person_id 'Ryan Temp')"; bob="$(person_id 'Bob Vance')"; pam="$(person_id 'Pam Bealey')"

# A previous run may have left Ryan deactivated (section 4). The workflow restores its own
# preconditions rather than assuming a fresh fixture.
if [ -z "$(assignment_of "$ryan")" ]; then
  as 'Jim Miller' jim.miller restricted
  act reactivate_person "$ryan" "workflow preflight: restore the contractor" >/dev/null
  kf grant-authority --person "$ryan" --organization "$org" --role performer --clearance internal --granted-by "$jim" --reason "workflow preflight: restore the contractor's authority" >/dev/null 2>&1 || true
fi

echo "== 1. what each person can read (RLS ceiling AND grant)"
as 'Bob Vance' bob.vance confidential
req GET "/documents/$brochure/source";  check "Bob reads the public brochure bytes" 200 "$STATUS" "$BODY"
req GET "/documents/$agreement/source"; check "Bob reads his own confidential agreement bytes" 200 "$STATUS" "$BODY"
req GET "/documents/$pricing/source";   check "Bob cannot read the confidential pricing sheet" 404 "$STATUS" "$BODY"
req GET "/objects/$pricing";            check "Bob cannot see the pricing sheet's Object View" 404 "$STATUS" "$BODY"
req GET "/objects/$pricing/access";     check "Bob can ask why (access explanation answers, or hides)" 404 "$STATUS" "$BODY"
req GET "/search?q=pricing";            check "search as Bob answers" 200 "$STATUS" "$BODY"
[ "$STATUS" = 200 ] && check "  …and shows Bob no pricing hit" 0 "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["hits"]))' "$secrets/last.json")"
req GET "/search?q=onboarding";         [ "$STATUS" = 200 ] && check "  …but finds the onboarding guide" 1 "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["hits"]))' "$secrets/last.json")" "$BODY"

as 'Karen Filo' karen.filo confidential
req GET "/documents/$pricing/source";   check "Karen (finance, confidential) reads the pricing sheet" 200 "$STATUS" "$BODY"
req GET "/documents/$board/source";     check "Karen cannot read the restricted board decision" 404 "$STATUS" "$BODY"
as 'Ryan Temp' ryan.temp internal
req GET "/documents/$agreement/source"; check "Ryan (contractor, internal) cannot read Vance's agreement" 404 "$STATUS" "$BODY"
req GET "/objects/$agreement";          check "Ryan cannot see its Object View either (a stale claim refreshes on demand first)" 404 "$STATUS" "$BODY"

echo "== 2. a session may not ask above its clearance"
as 'Pam Bealey' pam.bealey restricted
req GET "/master-record";               check "Pam (internal) asking at restricted is refused as identity" 401 "$STATUS" "$BODY"

echo "== 3. a grant is a decision by the owner, and a revocation leaves evidence"
as 'Jim Miller' jim.miller restricted
act grant_access "$pricing" "Ryan needs the pricing sheet for one quote" "{\"principal_kind\":\"person\",\"principal_id\":\"$ryan\",\"capability\":\"read\"}"
check "Jim grants Ryan read on the pricing sheet (the act records)" 201 "$STATUS" "$BODY"
as 'Ryan Temp' ryan.temp internal
req GET "/documents/$pricing/source";   check "Ryan STILL cannot read it: his clearance is internal, the sheet is confidential" 404 "$STATUS" "$BODY"
as 'Jim Miller' jim.miller restricted
grant_id="$(psql_scoped "select id from org.access_grant where principal_id = $(q "$ryan") and scope_object_id = $(q "$pricing") and revoked_at is null order by granted_at desc limit 1")"
act revoke_access "$pricing" "quote delivered; the sheet was never reachable at his clearance anyway" "{\"grant_id\":\"$grant_id\"}"
check "Jim revokes it; the grant row stays as evidence" 201 "$STATUS" "$BODY"
check "  …revoked_at is set, the row is not deleted" 1 "$(psql_scoped "select count(*) from org.access_grant where id = $(q "$grant_id") and revoked_at is not null")"

echo "== 4. a contractor leaves, and comes back"
as 'Jim Miller' jim.miller restricted
act deactivate_person "$ryan" "contract ended 2026-09-11"; check "Jim deactivates Ryan" 201 "$STATUS" "$BODY"
as_ryan_token="$(token_for ryan.temp)"; ryan_assignment_before="$A"
STATUS="$(curl -s -o "$secrets/last.json" -w '%{http_code}' -H "Authorization: Bearer $as_ryan_token" -H "x-kf-organization: $org" -H "x-kf-acting-role: $(psql_scoped "select id from org.role_assignment where subject_id = $(q "$ryan") order by valid_from desc limit 1")" -H "x-kf-classification: internal" "$API/master-record")"
check "Ryan's session is refused at once — his assignment ended under the act" 401 "$STATUS" "$(head -c 200 "$secrets/last.json")"
check "  …his clearance is retired with a reason" retired "$( [ "$(psql_scoped "select count(*) from org.person_clearance_retirement r join org.person_clearance c on c.id = r.clearance_id where c.subject_id = $(q "$ryan")")" -ge 1 ] && echo retired || echo none)"
as 'Jim Miller' jim.miller restricted
act reactivate_person "$ryan" "re-engaged for Q4"; check "Jim reactivates Ryan (restores NOTHING by itself)" 201 "$STATUS" "$BODY"
kf grant-authority --person "$ryan" --organization "$org" --role performer --clearance internal --granted-by "$jim" --reason "re-engaged for Q4: fresh authority, fresh reason" >/dev/null 2> "$secrets/regrant.err"
check "  …and re-grants him; a fresh assignment and clearance" 1 "$(psql_scoped "select count(*) from org.role_assignment where subject_id = $(q "$ryan") and valid_to is null")" "$(head -c 200 "$secrets/regrant.err")"
as 'Ryan Temp' ryan.temp internal
req GET "/master-record";               check "Ryan's new session is a session again (his old claim is stale or absent)" session "$( [ "$STATUS" = 404 ] || [ "$STATUS" = 409 ] && echo session || echo "$STATUS")" "$BODY"

echo "== 5. an employee adds a record; who sees it"
as 'Pam Bealey' pam.bealey internal
tmp="$(mktemp -d)"; printf '# Truck 7 maintenance log\n\nBrakes serviced 2026-09-10. Next inspection 2026-12-10.\n' > "$tmp/truck-7-maintenance-log.md"
if kf ingest --mode=copy --kind=document --classification=internal --identity=oidc --organization="$org" --acting-role="$A" --token-file="$tokens/pam.bealey" --reason "routine fleet record" --json "$tmp/truck-7-maintenance-log.md" > "$secrets/ingest.json" 2> "$secrets/ingest.err"; then ing=0; else ing=$?; fi
check "Pam ingests an internal fleet record (as herself, via her token)" 0 "$ing" "$(head -c 300 "$secrets/ingest.err")"
if kf ingest --mode=copy --kind=document --classification=restricted --identity=oidc --organization="$org" --acting-role="$A" --token-file="$tokens/pam.bealey" --reason "should be refused" --json "$tmp/truck-7-maintenance-log.md" > /dev/null 2> "$secrets/ingest2.err"; then ing=0; else ing=$?; fi
check "Pam cannot ingest at restricted (above her clearance)" refused "$( [ "$ing" -ne 0 ] && echo refused || echo allowed)" "$(head -c 200 "$secrets/ingest2.err")"
as 'Robert California' robert.california confidential
key="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
req POST /master-record/compile "{\"idempotencyKey\":\"$key\"}"; check "Robert recompiles" 201 "$STATUS" "$BODY"
req GET "/master-record/projections/master_sections?format=json"
check "  …and the fleet record (internal) is in his record" 1 "$(titles | grep -c truck-7)"
as 'Bob Vance' bob.vance confidential
key="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
req POST /master-record/compile "{\"idempotencyKey\":\"$key\"}"; check "Bob recompiles (new claim: Ryan's assignments changed his corpus too)" 201 "$STATUS" "$BODY"
req GET "/master-record/projections/master_sections?format=json"
check "  …and the fleet record is NOT in Bob's (customer, public-scoped role)" 0 "$(titles | grep -c truck-7)"

echo "== 6. the record is exact: a stale claim is refused, not served"
as 'Jim Miller' jim.miller restricted
req GET "/master-record";               check "Jim's claim is stale after Pam's ingest (409, never a quiet old page)" 409 "$STATUS" "$BODY"
key="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
req POST /master-record/compile "{\"idempotencyKey\":\"$key\"}"; check "  …recompiling makes a new claim" 201 "$STATUS" "$BODY"
req GET "/master-record";               check "  …which serves" 200 "$STATUS" "$BODY"

echo; echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
