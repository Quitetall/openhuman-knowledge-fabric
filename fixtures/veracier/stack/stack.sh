#!/usr/bin/env bash
#
# The Véracier fixture stack on a workstation, in the dogfood profile.
#
#   fixtures/veracier/stack/stack.sh up       # dependencies, migrations, logins, realm, apps
#   fixtures/veracier/stack/stack.sh load     # load the fixture (--sample: ~80 documents), restart
#   fixtures/veracier/stack/stack.sh restart  # restart the applications (logins kept)
#   fixtures/veracier/stack/stack.sh down     # stop the apps and the containers (data kept)
#   fixtures/veracier/stack/stack.sh status   # what is running, and where
#   fixtures/veracier/stack/stack.sh reset    # down, then DELETE the fixture's volumes and state
#
# Its own compose project (`kf-veracier`), containers, volumes, ports and state directory, so it
# never touches the default `openhuman-knowledge-fabric` stack or its database:
#
#   web      http://localhost:3100          API  http://127.0.0.1:4100
#   Keycloak http://localhost:18080         PostgreSQL 127.0.0.1:15432   MinIO 127.0.0.1:19000
#   state    ~/.local/state/kf-veracier     (0700; credentials 0600, never printed)
#
# The processes are the ones a dogfood host runs, built from this checkout: kf-attestor (its dev
# entry, on a Unix socket), the API under KF_DEPLOYMENT_PROFILE=dogfood holding kf_app only, the
# worker holding kf_worker only (it delivers the outbox, which is what indexes records for
# search), and the web application as a production build (`next start`). Each holds exactly one
# database login, created by `pnpm dogfood:logins`; none is handed the owner credential.
#
# Parameterized, so one script runs any fixture stack beside another (fixtures/multi/stack.sh runs
# every corpus as its own organization in one stack this way). Unset, each is the Véracier value:
#
#   KF_STACK_PROJECT        compose project, container prefix, default state dir   kf-veracier
#   KF_STACK_STATE          state directory                                       ~/.local/state/<project>
#   KF_STACK_WEB_PORT / KF_STACK_API_PORT / KF_STACK_KEYCLOAK_PORT                3100 / 4100 / 18080
#   KF_STACK_PG_PORT / KF_STACK_MINIO_PORT / KF_STACK_MINIO_CONSOLE_PORT          15432 / 19000 / 19001
#   KF_STACK_FIXTURE        what `load` loads (`node fixtures/cli.mjs <it>`)      veracier
#   KF_STACK_ORGANIZATION   legal name the web app's context picker lists         Véracier Industries S.A.
#   KF_STACK_SKIP_BUILD     1 skips the build (KF_VERACIER_SKIP_BUILD also works)
#
# Loopback only. Keycloak runs `start-dev` and PostgreSQL and MinIO use the public development
# credentials from docker-compose.yml; this is not a network service.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
export KF_STACK_PROJECT="${KF_STACK_PROJECT:-kf-veracier}"
export KF_STACK_STATE="${KF_STACK_STATE:-${KF_VERACIER_STATE:-$HOME/.local/state/$KF_STACK_PROJECT}}"
state="$KF_STACK_STATE"
logs="$state/logs"
run="$state/run"

export KF_STACK_WEB_PORT="${KF_STACK_WEB_PORT:-${KF_VERACIER_WEB_PORT:-3100}}"
export KF_STACK_API_PORT="${KF_STACK_API_PORT:-${KF_VERACIER_API_PORT:-4100}}"
export KF_STACK_KEYCLOAK_PORT="${KF_STACK_KEYCLOAK_PORT:-18080}"
export KF_STACK_PG_PORT="${KF_STACK_PG_PORT:-15432}"
export KF_STACK_MINIO_PORT="${KF_STACK_MINIO_PORT:-19000}"
export KF_STACK_MINIO_CONSOLE_PORT="${KF_STACK_MINIO_CONSOLE_PORT:-19001}"
fixture="${KF_STACK_FIXTURE:-veracier}"
organization_name="${KF_STACK_ORGANIZATION:-Véracier Industries S.A.}"
# The names the loader and the tests have always read.
export KF_VERACIER_WEB_PORT="$KF_STACK_WEB_PORT" KF_VERACIER_API_PORT="$KF_STACK_API_PORT"
keycloak_origin="http://localhost:$KF_STACK_KEYCLOAK_PORT"
realm='knowledge-fabric'
web_origin="http://localhost:$KF_STACK_WEB_PORT"

compose() {
  KF_DEPLOYMENT_PROFILE=dogfood \
    KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME=admin \
    KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD="$(cat "$state/keycloak-admin-password")" \
    docker compose -p "$KF_STACK_PROJECT" -f "$repo/docker-compose.yml" -f "$here/compose.yml" "$@"
}

# The environment every application process shares. Only non-secret values; each process gets
# its one credential as a *_FILE path, and the development MinIO secret is the public value
# docker-compose.yml already publishes.
app_env() {
  export XDG_STATE_HOME="$state"
  export KF_ATTESTOR_SOCKET="$run/attestor.sock"
  export OIDC_ISSUER="$keycloak_origin/realms/$realm"
  export OIDC_AUDIENCE='knowledge-fabric-api'
  export OIDC_JWKS_URI="$keycloak_origin/realms/$realm/protocol/openid-connect/certs"
  export S3_ENDPOINT="http://localhost:$KF_STACK_MINIO_PORT"
  export S3_REGION='us-east-1'
  export S3_ACCESS_KEY_ID='kf-dev-access-key'
  export S3_SECRET_ACCESS_KEY='dev-only-not-a-secret'
  export S3_FORCE_PATH_STYLE='true'
  export S3_BUCKET_ARTIFACTS='kf-artifacts'
  export S3_BUCKET_SNAPSHOTS='kf-snapshots'
  export S3_BUCKET_CHECKPOINTS='kf-checkpoints'
  export S3_BUCKET_EXPORTS='kf-exports'
  export LOG_LEVEL="${LOG_LEVEL:-info}"
  unset DATABASE_URL DATABASE_OWNER_URL DATABASE_OWNER_URL_FILE KF_DEV_ACTOR KF_DEV_ACTING_ROLE \
    KF_DEV_ORGANIZATION KF_ALLOW_FIXED_IDENTITY
}

owner_env() {
  # The owner connection, for migrations and the logins only. The password is the public
  # development value from docker-compose.yml; it still goes through the environment, not argv.
  export PGPASSWORD='dev-only-not-a-secret'
  export DATABASE_OWNER_URL="postgres://kf_owner@localhost:$KF_STACK_PG_PORT/kf?sslmode=disable"
}

secret_file() { # secret_file <path> <python expression producing the value>
  if [ ! -s "$1" ]; then
    (umask 077; python3 -c "import base64, secrets; print($2)" > "$1")
  fi
  chmod 600 "$1"
}

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_process() { # start_process <name> <cwd> <command...>
  local name="$1" cwd="$2"
  shift 2
  if pid_alive "$run/$name.pid"; then
    echo "  $name already running (pid $(cat "$run/$name.pid"))"
    return 0
  fi
  rm -f "$run/$name.pid"
  # A session of its own, whose leader writes its OWN pid before it execs: that pid is also the
  # process group, so `down` stops the process and anything it started (next start's server).
  # Recording `$!` instead recorded setsid's short-lived parent whenever setsid had to fork.
  (cd "$cwd" && setsid bash -c 'echo $$ > "$0"; exec "$@"' "$run/$name.pid" "$@" \
    >"$logs/$name.log" 2>&1 </dev/null &)
  local waited=0
  until [ -s "$run/$name.pid" ] || [ "$waited" -ge 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  echo "  $name started (pid $(cat "$run/$name.pid")), log $logs/$name.log"
}

wait_for() { # wait_for <what> <seconds> <command...>
  local what="$1" limit="$2"
  shift 2
  local deadline=$((SECONDS + limit))
  until "$@" >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "$what did not come up in ${limit}s" >&2
      return 1
    fi
    sleep 1
  done
}

kc_admin_token() {
  KC_P="$(cat "$state/keycloak-admin-password")" python3 -c '
import os, urllib.parse
print(urllib.parse.urlencode({"client_id": "admin-cli", "grant_type": "password",
  "username": "admin", "password": os.environ["KC_P"]}), end="")' |
    curl -sS --fail-with-body --max-time 15 -d @- \
      "$keycloak_origin/realms/master/protocol/openid-connect/token" |
    python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])'
}

# The committed realm registers http://localhost:3000/auth/callback. The fixture's web
# application listens elsewhere, so its redirect and origin are added to THIS Keycloak's client
# (the committed realm file is untouched, and the default stack's Keycloak is a different one).
patch_realm_client() {
  local token client
  token="$(kc_admin_token)"
  client="$(curl -sS --fail-with-body --max-time 15 -H "Authorization: Bearer $token" \
    "$keycloak_origin/admin/realms/$realm/clients?clientId=knowledge-fabric-web" |
    python3 -c 'import sys, json; c = json.load(sys.stdin); print(c[0]["id"])')"
  curl -sS --fail-with-body --max-time 15 -H "Authorization: Bearer $token" \
    "$keycloak_origin/admin/realms/$realm/clients/$client" |
    WEB="$web_origin" python3 -c '
import json, os, sys
c = json.load(sys.stdin)
web = os.environ["WEB"]
c["redirectUris"] = sorted(set(c.get("redirectUris", [])) | {web + "/auth/callback"})
c["webOrigins"] = sorted(set(c.get("webOrigins", [])) | {web})
attrs = c.setdefault("attributes", {})
posts = set(filter(None, attrs.get("post.logout.redirect.uris", "").split("##")))
attrs["post.logout.redirect.uris"] = "##".join(sorted(posts | {web + "/", web + "/*"}))
print(json.dumps(c))' |
    curl -sS --fail-with-body --max-time 15 -o /dev/null -X PUT \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d @- \
      "$keycloak_origin/admin/realms/$realm/clients/$client"
}

up() {
  install -d -m 0700 "$state" "$logs" "$run"
  secret_file "$state/keycloak-admin-password" 'secrets.token_urlsafe(24)'
  secret_file "$state/web-session-secret" 'base64.b64encode(secrets.token_bytes(32)).decode()'

  echo "== dependencies (compose project $KF_STACK_PROJECT)"
  compose up -d --wait postgres minio keycloak
  compose up minio-init >/dev/null

  echo '== database'
  owner_env
  (cd "$repo" && DATABASE_URL="$DATABASE_OWNER_URL" node_modules/.bin/dbmate \
    --migrations-dir ./database/migrations --no-dump-schema --wait up >"$logs/migrate.log" 2>&1) || {
    echo "migration failed; see $logs/migrate.log" >&2
    return 1
  }
  psql "$DATABASE_OWNER_URL" -X -v ON_ERROR_STOP=1 -q \
    -f "$repo/generated/sql-registry/001-ontology-seed.sql" >"$logs/seed.log" 2>&1 || {
    echo "ontology seed failed; see $logs/seed.log" >&2
    return 1
  }
  echo "  $(psql "$DATABASE_OWNER_URL" -X -tAc 'select count(*) from public.schema_migrations') migrations applied"

  if [ "${KF_STACK_SKIP_BUILD:-${KF_VERACIER_SKIP_BUILD:-0}}" = 1 ]; then
    echo '== build skipped (KF_STACK_SKIP_BUILD=1): running what is already built'
  else
    echo '== build (pnpm build; KF_STACK_SKIP_BUILD=1 skips it)'
    (cd "$repo" && pnpm -s build >"$logs/build.log" 2>&1) || {
      echo "build failed; see $logs/build.log" >&2
      return 1
    }
  fi

  echo '== logins (pnpm dogfood:logins; re-keyed on every up)'
  for name in api worker attestor; do
    if pid_alive "$run/$name.pid"; then
      echo "  $name is running; its login would be re-keyed under it. Run 'down' first." >&2
      return 1
    fi
  done
  (cd "$repo" && XDG_STATE_HOME="$state" NODE_ENV=development node apps/api/dist/dogfood-logins.js |
    sed -n '1,3s/^/  /p')
  unset PGPASSWORD DATABASE_OWNER_URL

  echo '== realm'
  wait_for 'keycloak' 120 curl -sf "$keycloak_origin/realms/$realm/.well-known/openid-configuration"
  patch_realm_client
  echo "  knowledge-fabric-web also accepts $web_origin/auth/callback"

  start_apps
}

# The fixture's organization (KF_STACK_ORGANIZATION), once the loader has created it: the web application's context
# picker lists a person's assignments in it (KF_WEB_ORGANIZATION). Empty before the first load.
fixture_organization() {
  # Through stdin: psql interpolates :'name' (quoted, so any legal name is safe) there, not in -c.
  echo "select coalesce(org.organization_by_name(:'name')::text, '')" |
    PGPASSWORD='dev-only-not-a-secret' psql "postgres://kf_owner@localhost:$KF_STACK_PG_PORT/kf?sslmode=disable" \
      -X -tA -v name="$organization_name" 2>/dev/null || true
}

start_apps() {
  echo '== applications'
  for port in "$KF_STACK_API_PORT" "$KF_STACK_WEB_PORT"; do
    if ! pid_alive "$run/api.pid" && ss -ltn "sport = :$port" | grep -q LISTEN; then
      echo "  port $port is already in use by something this script did not start" >&2
      return 1
    fi
  done
  app_env
  local files="$state/knowledge-fabric"
  local organization
  organization="$(fixture_organization)"
  NODE_ENV=development start_process attestor "$repo" node apps/attestor/dist/dev.js
  wait_for 'kf-attestor' 60 curl -sf --unix-socket "$KF_ATTESTOR_SOCKET" http://attestor/health
  NODE_ENV=development KF_DEPLOYMENT_PROFILE=dogfood HOST=127.0.0.1 PORT="$KF_STACK_API_PORT" \
    DATABASE_URL_FILE="$files/dogfood-api-database-url" \
    start_process api "$repo" node apps/api/dist/server.js
  NODE_ENV=development KF_DEPLOYMENT_PROFILE=dogfood DATABASE_URL_FILE="$files/worker-database-url" \
    start_process worker "$repo" node apps/worker/dist/main.js
  NODE_ENV=production KF_DEPLOYMENT_PROFILE=dogfood KF_API_URL="http://127.0.0.1:$KF_STACK_API_PORT" \
    KF_WEB_OIDC_ISSUER="$OIDC_ISSUER" KF_WEB_OIDC_CLIENT_ID='knowledge-fabric-web' \
    KF_WEB_OIDC_REDIRECT_URI="$web_origin/auth/callback" \
    KF_WEB_SESSION_SECRET_FILE="$state/web-session-secret" \
    KF_WEB_ORGANIZATION="$organization" \
    start_process web "$repo/apps/web" node_modules/.bin/next start --hostname 127.0.0.1 \
    --port "$KF_STACK_WEB_PORT"
  wait_for 'API' 60 curl -sf "http://127.0.0.1:$KF_STACK_API_PORT/health"
  wait_for 'web' 60 curl -sf -o /dev/null "http://127.0.0.1:$KF_STACK_WEB_PORT/"
  if [ -z "$organization" ]; then
    echo '  (no fixture organization yet: load it, then `stack.sh restart` so the web app lists'
    echo '   assignments in the context picker)'
  fi
  status
}

stop_apps() {
  for name in web worker api attestor; do
    if pid_alive "$run/$name.pid"; then
      local pid
      pid="$(cat "$run/$name.pid")"
      # Each process leads its own session; stop the group so `next start` children go too.
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
      # Wait for it to be gone (20 s), or `restart` finds its port still held and refuses.
      local waited=0
      while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 200 ]; do
        sleep 0.1
        waited=$((waited + 1))
      done
      echo "  stopped $name"
    fi
    rm -f "$run/$name.pid"
  done
}

# Load the fixture (all of it, or `--sample`) into the running stack, then restart the
# applications so the web application knows the organization it now holds.
load() {
  (cd "$repo" && node fixtures/cli.mjs "$fixture" "$@")
  stop_apps
  start_apps
}

down() {
  stop_apps
  if [ -f "$state/keycloak-admin-password" ]; then compose stop >/dev/null 2>&1 || true; fi
  echo '  containers stopped (volumes kept; `reset` deletes them)'
}

status() {
  for name in attestor api worker web; do
    if pid_alive "$run/$name.pid"; then
      printf '  %-9s running  pid %s\n' "$name" "$(cat "$run/$name.pid")"
    else
      printf '  %-9s stopped\n' "$name"
    fi
  done
  printf '  %-9s %s\n' web "$web_origin" api "http://127.0.0.1:$KF_STACK_API_PORT" \
    keycloak "$keycloak_origin" state "$state"
}

reset() {
  down
  if [ -f "$state/keycloak-admin-password" ]; then compose down -v; fi
  rm -rf "$state"
  echo "  fixture volumes and $state deleted"
}

command="${1:-}"
shift || true
case "$command" in
  up) up ;;
  load) load "$@" ;;
  restart)
    stop_apps
    start_apps
    ;;
  down) down ;;
  status) status ;;
  reset) reset ;;
  *)
    echo "usage: $0 up|load [--sample]|restart|down|status|reset" >&2
    exit 2
    ;;
esac
