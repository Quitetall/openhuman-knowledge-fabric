#!/usr/bin/env bash
#
# Munder Diffin Paper Shredding Co. — the demonstration company, end to end, on a real host.
#
# Every step below is the path a real institution takes. Nothing is written to the database
# directly except where the platform itself says it must be (the bootstrap tier: the first
# people in an organization and their first authority). Every document is ingested as a
# dispatched act by a person holding a verified token; every access grant is dispatched over the
# API by the person who decided it; every master record is compiled and fetched over the API as
# the person it belongs to. If any of that refuses, this script stops there and says so — the
# fixture is not "set up" by working around the refusal.
#
# Runs ON the host, as root (it reads the owner credential and the identity admin credential).
#
#   sudo fixtures/munder-diffin/setup.sh --docs /path/to/fixtures/munder-diffin/documents \
#        --out /path/for/master-records [--release /opt/kf]
#
# Idempotent: people, accounts, grants and ingested documents are reused when already present.

set -euo pipefail

release='/opt/kf'
docs=''
out=''
while [ $# -gt 0 ]; do
  case "$1" in
    --release) release="$2"; shift 2 ;;
    --docs) docs="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$docs" ] && [ -d "$docs" ] || { echo "--docs must name the documents directory" >&2; exit 2; }
[ -n "$out" ] || { echo "--out must name where master records are written" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root: this reads the owner and identity credentials" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_scripts="$here/../../scripts/deploy"
login="$repo_scripts/login-token.sh"
[ -x "$login" ] || login="$release/scripts/deploy/login-token.sh"
[ -x "$login" ] || { echo "login-token.sh not found beside this script or in the release" >&2; exit 2; }

kf() { node "$release/apps/api/dist/cli.js" "$@"; }

# ── configuration the host already has ──────────────────────────────────────────────────
set -a
. /etc/kf/api.env
set +a
# The TABLE OWNER, not the application's "owner" login. Bootstrap-tier commands read across
# organizations (a decider in one, a duplicate in another) and `org.person` / `org.organization`
# enable row-level security without forcing it: the table owner reads past the policy, any other
# login sees only the bound organization. That is the configuration every database test runs
# under, and on this host the table owner is the migrator credential. Overridable for a host
# whose bootstrap login IS the owner.
owner_file="${KF_BOOTSTRAP_DATABASE_URL_FILE:-/etc/kf/migrator/database-url}"
export DATABASE_OWNER_URL_FILE="$owner_file"
export DATABASE_OWNER_URL="$(cat "$owner_file")"
export DATABASE_URL_FILE=/etc/kf/api/database-url
export S3_SECRET_ACCESS_KEY_FILE=/etc/kf/api/s3-secret-access-key
export KF_API_ORIGIN="${KF_API_ORIGIN:-https://api.kf.internal}"
export KF_OIDC_ISSUER="$OIDC_ISSUER"
export KF_REDIRECT_URI="${KF_REDIRECT_URI:-https://kf.internal/auth/callback}"
export CURL_CA_BUNDLE="${NODE_EXTRA_CA_CERTS:-}"
export NODE_ENV=production

psql_owner() { psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -X -A -t -q -c "$1"; }
# Refuse a credential that is not the table owner: every cross-organization lookup below would
# quietly return nothing and the run would report an empty company rather than a wrong login.
owner_check="$(psql_owner "select case when tableowner = current_user then 'owner' else current_user || ' is not ' || tableowner end from pg_tables where schemaname = 'org' and tablename = 'person'")"
[ "$owner_check" = owner ] || { echo "bootstrap credential must be the table owner: $owner_check" >&2; exit 2; }
# SQL literal: single quotes doubled. Every value below is a constant from this file, but a
# query built by interpolation is a query built by interpolation.
q() { printf "'%s'" "${1//\'/\'\'}"; }

# ── the company ─────────────────────────────────────────────────────────────────────────
legal_name='Munder Diffin Paper Shredding Co.'
org="$(psql_owner "select id from org.organization where legal_name = $(q "$legal_name") and retired_at is null")"
if [ -z "$org" ]; then
  echo "no active organization named '$legal_name'; bootstrap it first:" >&2
  echo "  kf bootstrap-organization --legal-name '$legal_name' --person 'Jim Miller'" >&2
  exit 1
fi
echo "organization $org  $legal_name"

# ── the people: name | username | role | clearance | role ceiling (or -) ───────────────
#
# A customer's or partner's contact is a person IN this organization's tenancy: row-level
# security scopes every record to one organization, so there is no other place they can read
# from. Their clearance admits their own agreement; the ceiling on their role assignment keeps
# the organization-wide grant that a role is down to what the organization publishes to them.
people=(
  'Jim Miller|jim.miller|project_owner|restricted|-'
  'Hank Shredder|hank.shredder|technical_authority|restricted|-'
  'Dwight Blunt|dwight.blunt|work_order_manager|confidential|-'
  'Karen Filo|karen.filo|finance_approver|confidential|-'
  'Toby Flint|toby.flint|quality_authority|confidential|-'
  'Pam Bealey|pam.bealey|performer|internal|-'
  'Ryan Temp|ryan.temp|performer|internal|-'
  'Bob Vance|bob.vance|customer_contact|confidential|public'
  'Robert California|robert.california|partner_contact|confidential|internal'
)

person_id() { psql_owner "select p.id from org.person p where p.organization = $(q "$org") and p.display_name = $(q "$1") order by p.id limit 1"; }
role_assignment_id() {
  psql_owner "select id from org.role_assignment where subject_id = $(q "$1") and scope_id = $(q "$org") and valid_from <= now() and (valid_to is null or valid_to > now()) order by valid_from limit 1"
}

echo; echo "== people"
declare -A PERSON
for entry in "${people[@]}"; do
  IFS='|' read -r name username role clearance ceiling <<<"$entry"
  id="$(person_id "$name")"
  if [ -z "$id" ]; then
    kf bootstrap-organization --organization "$org" --person "$name" >/dev/null
    id="$(person_id "$name")"
  fi
  PERSON["$name"]="$id"
  printf '  %-18s %s\n' "$name" "$id"
done

# ── the accounts ────────────────────────────────────────────────────────────────────────
#
# Passwords are generated once and kept root-only. They are fixture credentials for a
# demonstration company on a private host; they are still credentials.
secrets_dir=/etc/kf/fixtures/munder-diffin
install -d -m 0700 "$secrets_dir"
passwords="$secrets_dir/passwords.env"
[ -f "$passwords" ] || { umask 077; : > "$passwords"; }

set -a
. /etc/kf/identity/admin.env
set +a
kc="${OIDC_ISSUER%/realms/*}"
realm="${OIDC_ISSUER##*/realms/}"

kc_admin_token() {
  KC_U="$KC_BOOTSTRAP_ADMIN_USERNAME" KC_P="$KC_BOOTSTRAP_ADMIN_PASSWORD" python3 -c '
import os, urllib.parse
print(urllib.parse.urlencode({"client_id": "admin-cli", "grant_type": "password",
  "username": os.environ["KC_U"], "password": os.environ["KC_P"]}), end="")' |
    curl -sS --fail-with-body --max-time 15 -d @- "$kc/realms/master/protocol/openid-connect/token" |
    python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])'
}

# Creates or updates one account and prints its subject. Password set only on creation.
kc_account() {
  local username="$1" name="$2" email="$3" password="$4" token subject status
  token="$(kc_admin_token)"
  local user_json
  user_json="$(KC_USER="$username" KC_NAME="$name" KC_EMAIL="$email" python3 -c '
import json, os
first, _, last = os.environ["KC_NAME"].partition(" ")
print(json.dumps({"username": os.environ["KC_USER"], "enabled": True, "email": os.environ["KC_EMAIL"],
  "emailVerified": True, "firstName": first, "lastName": last or "-", "requiredActions": []}))')"
  status="$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "$user_json" "$kc/admin/realms/$realm/users")"
  case "$status" in 201|409) ;; *) echo "creating $username: HTTP $status" >&2; return 1 ;; esac
  token="$(kc_admin_token)"
  subject="$(curl -sS --fail-with-body --max-time 15 -G -H "Authorization: Bearer $token" \
    --data-urlencode "username=$username" --data-urlencode 'exact=true' \
    "$kc/admin/realms/$realm/users" | python3 -c '
import json, sys
users = json.load(sys.stdin)
sys.exit("expected one user") if len(users) != 1 else print(users[0]["id"])')"
  if [ "$status" = 201 ]; then
    token="$(kc_admin_token)"
    KC_PW="$password" python3 -c 'import json, os; print(json.dumps({"type": "password", "value": os.environ["KC_PW"], "temporary": False}), end="")' |
      curl -sS --fail-with-body --max-time 15 -o /dev/null -X PUT \
        -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d @- \
        "$kc/admin/realms/$realm/users/$subject/reset-password"
  fi
  echo "$subject"
}

echo; echo "== accounts ($kc, realm $realm)"
declare -A SUBJECT
for entry in "${people[@]}"; do
  IFS='|' read -r name username role clearance ceiling <<<"$entry"
  var="PW_${username//./_}"
  if ! grep -q "^$var=" "$passwords"; then
    echo "$var=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')" >> "$passwords"
  fi
  domain='munderdiffin.example'
  case "$username" in bob.vance) domain='vancerefrigeration.example' ;; robert.california) domain='sabreprinters.example' ;; esac
  SUBJECT["$name"]="$(kc_account "$username" "$name" "$username@$domain" "$(grep "^$var=" "$passwords" | cut -d= -f2-)")"
  printf '  %-18s %s\n' "$username" "${SUBJECT[$name]}"
done

# ── authority ───────────────────────────────────────────────────────────────────────────
#
# Jim Miller's grant is the founding grant: nobody in the organization holds a role, so he
# grants himself, once, and the act is recorded under the assignment it creates. Everyone
# after him is granted BY him.
echo; echo "== authority"
jim="${PERSON['Jim Miller']}"
for entry in "${people[@]}"; do
  IFS='|' read -r name username role clearance ceiling <<<"$entry"
  args=(--person "${PERSON[$name]}" --organization "$org" --role "$role" --clearance "$clearance"
        --granted-by "$jim" --issuer "$OIDC_ISSUER" --subject "${SUBJECT[$name]}"
        --reason "Munder Diffin fixture: $name holds $role at $clearance, decided by Jim Miller")
  [ "$ceiling" = '-' ] || args+=(--role-ceiling "$ceiling")
  kf grant-authority "${args[@]}" | sed 's/^/  /'
done

# ── tokens ──────────────────────────────────────────────────────────────────────────────
tokens="$secrets_dir/tokens"
install -d -m 0700 "$tokens"
token_for() {
  local username="$1" var="PW_${1//./_}"
  KF_LOGIN_PASSWORD="$(grep "^$var=" "$passwords" | cut -d= -f2-)" "$login" "$username" "$tokens/$username" >/dev/null
  echo "$tokens/$username"
}

# ── the documents, ingested by Jim ──────────────────────────────────────────────────────
echo; echo "== documents"
jim_role="$(role_assignment_id "$jim")"
jim_token="$(token_for jim.miller)"
for classification in public internal confidential restricted; do
  dir="$docs/$classification"
  [ -d "$dir" ] || continue
  for file in "$dir"/*.md; do
    title="$(basename "$file")"
    existing="$(psql_owner "select count(*) from core.object where organization_id = $(q "$org") and object_type = 'artifact' and title = $(q "$title")")"
    if [ "$existing" != 0 ]; then
      printf '  %-14s %-52s already ingested\n' "$classification" "$title"
      continue
    fi
    kf ingest --mode=copy --kind=other --classification="$classification" --identity=oidc \
      --organization="$org" --acting-role="$jim_role" --token-file="$jim_token" \
      --reason="Munder Diffin fixture: $classification record ingested by Jim Miller" \
      --json "$file" > /dev/null
    printf '  %-14s %-52s ingested\n' "$classification" "$title"
  done
done

# ── object-scoped grants: each external contact reads their own agreement ───────────────
#
# Dispatched over the API as Jim, like any act. Their clearance admits `confidential`; the
# ceiling on their role keeps every OTHER confidential record out of the organization-wide
# grant; this names the one record each may read.
echo; echo "== access grants"
artifact_id() { psql_owner "select id from core.object where organization_id = $(q "$org") and object_type = 'artifact' and title = $(q "$1") order by id limit 1"; }
grant_read() {
  local person="$1" title="$2" object
  object="$(artifact_id "$title")"
  [ -n "$object" ] || { echo "  no artifact titled $title" >&2; return 1; }
  local live
  live="$(psql_owner "select count(*) from org.access_grant where organization_id = $(q "$org") and principal_kind = 'person' and principal_id = $(q "$person") and scope_object_id = $(q "$object") and capability = 'read' and revoked_at is null")"
  if [ "$live" != 0 ]; then printf '  %-52s already granted\n' "$title"; return 0; fi
  local body status
  body="$(KF_T="$object" KF_P="$person" KF_TITLE="$title" python3 -c '
import hashlib, json, os
target, person, title = os.environ["KF_T"], os.environ["KF_P"], os.environ["KF_TITLE"]
key = hashlib.sha256(("munder-fixture-grant:" + person + ":" + target).encode()).hexdigest()
print(json.dumps({"targetIds": [target], "idempotencyKey": key,
  "reason": "Munder Diffin fixture: the counterparty contact reads their own agreement (" + title + ")",
  "payload": {"principal_kind": "person", "principal_id": person, "capability": "read"}}))')"
  status="$(curl -sS -o "$secrets_dir/last-grant.json" --max-time 30 -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $(cat "$jim_token")" -H "x-kf-organization: $org" \
    -H "x-kf-acting-role: $jim_role" -H 'x-kf-classification: restricted' \
    -H 'Content-Type: application/json' -d "$body" "$KF_API_ORIGIN/actions/grant_access")"
  case "$status" in 200|201) printf '  %-52s granted\n' "$title" ;;
    *) echo "  grant_access on $title: HTTP $status $(cat "$secrets_dir/last-grant.json")" >&2; return 1 ;; esac
}
grant_read "${PERSON['Bob Vance']}" 'vance-refrigeration-service-agreement.md'
grant_read "${PERSON['Robert California']}" 'sabre-printers-partner-integration-spec.md'

# ── every person's master record, compiled and fetched as that person ───────────────────
echo; echo "== master records → $out"
install -d -m 0755 "$out"
for entry in "${people[@]}"; do
  IFS='|' read -r name username role clearance ceiling <<<"$entry"
  token="$(token_for "$username")"
  assignment="$(role_assignment_id "${PERSON[$name]}")"
  for format in html markdown json; do
    ext="$format"; [ "$format" = markdown ] && ext=md
    extra=(); [ "$format" = html ] || extra=(--no-compile)
    kf master-record --token-file "$token" --organization "$org" --acting-role "$assignment" \
      --classification "$clearance" --format "$format" --out "$out/$username.$ext" "${extra[@]}" \
      --reason "Munder Diffin fixture: $name asks for their master record" 2> "$out/$username.$ext.log"
  done
  printf '  %-18s %-20s %-12s %s\n' "$name" "$role" "$clearance" "$(grep -c '<li>' "$out/$username.html") members"
done
echo; echo "done. Master records in $out; per-person logs beside them."
