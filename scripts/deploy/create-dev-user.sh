#!/usr/bin/env bash
#
# Create one local development user in the `knowledge-fabric` realm and print the subject
# claim that `linkIdentity` needs.
#
# WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM THE REALM FILE
#
# `deploy/keycloak/knowledge-fabric-realm.json` is a partial export taken with users EXCLUDED,
# and the export step asserts that they are absent. A realm export that carries users carries
# their credential representations, and a credential in git is disclosed permanently — reverting
# the commit does not undo it. So the realm ships complete except for the one thing that cannot
# be committed, and this script supplies it at runtime from an environment variable.
#
# The consequence is deliberate and worth stating: a fresh clone gets a realm with no users and
# CANNOT log in until this is run. That is the correct failure. The alternative is a shipped
# account whose password is public, on a service every deployment profile points at.
#
# WHAT IT DOES NOT DO
#
# It creates a Keycloak account. It does not make that account able to use the Fabric. The
# subject must still be linked to a person through `org.external_identity`, and that person needs
# a role assignment and a clearance (ADR 0011). `linkIdentity` in
# packages/authorization/src/identity.ts is "deliberately not automatic" — somebody decides that
# this account is that person and that decision is recorded with who made it. This script ends by
# printing exactly the values that decision needs.
#
# usage: KF_DEV_USER_PASSWORD=... scripts/deploy/create-dev-user.sh [username]
#        default username: dogfood
#
# Requires KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME and KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD in the
# environment: `set -a; . ./.env; set +a`.

set -euo pipefail

realm='knowledge-fabric'
username="${1:-dogfood}"
base_url="${KEYCLOAK_BASE_URL:-http://localhost:8080}"

: "${KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME:?source .env first — admin username is not set}"
: "${KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD:?source .env first — admin password is not set}"
: "${KF_DEV_USER_PASSWORD:?set KF_DEV_USER_PASSWORD — this script will not invent or default a credential}"

# Loopback only. This script mints a password-bearing account with a credential taken from the
# shell environment, which is a development convenience and nothing more. Pointed at a real host
# it would create exactly the kind of account a private host is supposed to refuse: no approval
# recorded, no owner, and a secret whose lifetime is a shell history file. Standing up identity
# on a host is `docs/deployment/private-host.md`'s job, and it goes through preflight.
case "$base_url" in
  http://localhost:* | http://127.0.0.1:*) ;;
  *)
    echo "refusing to create a development account against a non-loopback Keycloak: $base_url" >&2
    echo "stand up host identity through docs/deployment/private-host.md instead" >&2
    exit 1
    ;;
esac

admin_token() {
  curl -sS --fail-with-body --max-time 10 \
    -d 'client_id=admin-cli' -d 'grant_type=password' \
    --data-urlencode "username=$KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME" \
    --data-urlencode "password=$KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD" \
    "$base_url/realms/master/protocol/openid-connect/token" |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])'
}

# Re-taken per call rather than held in a variable: the admin token is short-lived and an export
# in this sequence has already failed with a 401 partway through.
token="$(admin_token)"

if ! curl -sS -o /dev/null --max-time 10 -w '%{http_code}' \
  "$base_url/realms/$realm/.well-known/openid-configuration" | grep -q '^200$'; then
  echo "realm '$realm' is not being served by $base_url" >&2
  echo "bring the stack up: docker compose up -d keycloak  (it imports deploy/keycloak/)" >&2
  exit 1
fi

# email, firstName and lastName are NOT cosmetic. The realm's declarative user profile marks
# them required, so a user created without them authenticates successfully and is then diverted
# to a VERIFY_PROFILE required action instead of being redirected back with a code. Measured:
# the first version of this script omitted them, the password was accepted, and the flow ended at
# /login-actions/required-action?execution=VERIFY_PROFILE with no `code` parameter. That reads
# exactly like a rejected credential and is not one.
user_json="$(KF_USERNAME="$username" python3 -c '
import json, os
u = os.environ["KF_USERNAME"]
print(json.dumps({
    "username": u,
    "enabled": True,
    "email": f"{u}@localhost.invalid",
    "emailVerified": True,
    "firstName": u,
    "lastName": "Dogfood",
    "requiredActions": [],
}))
')"

# 201 on create, 409 if it already exists. Both are success here — this is meant to be safe to
# re-run, and a second run should bring the account back to this shape rather than refuse.
create_status="$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' \
  -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "$user_json" "$base_url/admin/realms/$realm/users")"

case "$create_status" in
  201) echo "created user '$username'" ;;
  409) echo "user '$username' already exists — updating its profile and password" ;;
  *)
    echo "unexpected status creating user '$username': $create_status" >&2
    exit 1
    ;;
esac

token="$(admin_token)"
subject="$(curl -sS --fail-with-body --max-time 10 -G -H "Authorization: Bearer $token" \
  --data-urlencode "username=$username" --data-urlencode 'exact=true' \
  "$base_url/admin/realms/$realm/users" |
  python3 -c '
import json, sys
users = json.load(sys.stdin)
if len(users) != 1:
    sys.exit(f"expected exactly one user, got {len(users)}")
print(users[0]["id"])
')"

# Re-apply the profile on the 409 path too. An account left over from an earlier run of this
# script may predate the fields above, and "already exists" must not mean "still broken".
token="$(admin_token)"
curl -sS --fail-with-body --max-time 10 -o /dev/null \
  -X PUT -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "$user_json" "$base_url/admin/realms/$realm/users/$subject"

token="$(admin_token)"
curl -sS --fail-with-body --max-time 10 -o /dev/null \
  -X PUT -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "$(KF_DEV_USER_PASSWORD="$KF_DEV_USER_PASSWORD" python3 -c '
import json, os
print(json.dumps({"type": "password", "value": os.environ["KF_DEV_USER_PASSWORD"], "temporary": False}))
')" \
  "$base_url/admin/realms/$realm/users/$subject/reset-password"

# The password is passed through the environment into python, never through the command line:
# an argv is world-readable in /proc for the life of the process.

cat <<EOF

user      $username
subject   $subject
issuer    $base_url/realms/$realm

The subject above is the 'sub' claim its tokens will carry. It is NOT yet usable against the
Fabric. Link it to a person, then give that person a role assignment and a clearance:

  linkIdentity(tx, {
    issuer:   '$base_url/realms/$realm',
    subject:  '$subject',
    personId: '<a live org.person id>',
    linkedBy: '<who decided this account is that person>',
  })

Keyed on (issuer, subject) because a subject is unique only within its issuer. See
docs/deployment/identity-and-login.md and docs/decisions/0011-master-record-runtime.md.
EOF
