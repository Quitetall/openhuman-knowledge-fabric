#!/usr/bin/env bash
#
# Provision a private host for the Knowledge Fabric, or report what it still lacks.
#
#   sudo /opt/kf/scripts/deploy/provision-host.sh            create everything a machine can
#   sudo /opt/kf/scripts/deploy/provision-host.sh --check    change nothing; list what is missing
#
#   --generate-recovery-key <file>   make the backup recovery keypair here: the public half
#                                    becomes /etc/kf/backup-recipient.asc, the secret half is
#                                    sealed for the restore drill and written ONCE to <file>
#                                    (0600, must not exist) for the recovery custodian to take
#                                    off this host. Omit it to supply your own public key.
#   --seal-drill-key <file>          seal an existing recovery secret key (OpenPGP, armored)
#                                    for the drill; <file> is read, never copied or printed.
#
# WHY IT EXISTS. The hardening of 2026-09-23 added a dozen host secrets and files — a receipt
# HMAC key, a readiness token, a pinned checkpoint key id, a sealed drill credential, two new
# identities, an object-store policy — each installed by a hand-typed line in
# deploy/systemd/README.md. A step typed by hand is a step skipped on the next host. This does
# every one a machine can do and ends with the list of inputs only a person can supply, each
# with the exact path it goes in.
#
# SAFE TO RE-RUN. Nothing that exists is regenerated or overwritten: a secret file with content
# is left alone, an env file is only ever completed (a placeholder filled, a missing line added),
# a user is created once. Re-running after supplying an input is how you confirm it took.
#
# SECRETS. Generated from /dev/urandom straight into a file this script created 0600, then
# chowned to the one identity that reads it. Never echoed, never an argument to any command,
# never in a log. The output names paths and non-secret values (a key id, a bucket) only.
#
# Environment (tests and unusual hosts only):
#   KF_PROVISION_ROOT   prefix every host path with this directory (a fake root; tests)
#   KF_RELEASE_DIR      the release whose templates and units to install (default: this one)
#   KF_PROVISION_NODE   the Node.js executable (default /usr/bin/node)
#   KF_OBJECTS_RELEASE_URL   where to fetch the pinned SeaweedFS tarball from (tests; default the
#                            upstream release URL in deploy/object-store/seaweedfs.release). The
#                            pinned digests are checked whatever the source.

set -euo pipefail
umask 077
export LC_ALL=C

usage() {
  sed -n '3,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
}

MODE=apply
RECOVERY_OUT=""
SEAL_KEY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --generate-recovery-key)
      [ "$#" -ge 2 ] || { usage; exit 64; }
      RECOVERY_OUT="$2"
      shift
      ;;
    --seal-drill-key)
      [ "$#" -ge 2 ] || { usage; exit 64; }
      SEAL_KEY="$2"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done
if [ -n "$RECOVERY_OUT" ] && [ -n "$SEAL_KEY" ]; then
  echo "provision-host: --generate-recovery-key and --seal-drill-key are alternatives" >&2
  exit 64
fi

PREFIX="${KF_PROVISION_ROOT:-}"
RELEASE="${KF_RELEASE_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
NODE="${KF_PROVISION_NODE:-/usr/bin/node}"
TEMPLATES="$RELEASE/deploy/systemd"
POLICY_TEMPLATE="$RELEASE/deploy/object-store/kf-storage-orphan-collection.policy.json"
POLICY_NAME=kf-storage-orphan-collection
# This host's own object store, kf-objects (ADR 0039): the endpoint the env templates default to.
LOCAL_OBJECTS=http://127.0.0.1:8333
WEED=/usr/local/lib/kf-objects/weed
SELF=/opt/kf/scripts/deploy/provision-host.sh

if [ "$MODE" = apply ] && [ -z "$PREFIX" ] && [ "$(id -u)" -ne 0 ]; then
  echo "provision-host: run as root (sudo); --check runs as anyone" >&2
  exit 1
fi

# Host path -> the path acted on (identical on a real host).
p() { printf '%s%s' "$PREFIX" "$1"; }

CREATED=()   # what this run made
PENDING=()   # machine-doable, not done (check mode)
HUMAN=()     # "path<US>what a person must supply", US = the ASCII unit separator (0x1f)

created() { CREATED+=("$1"); }
pending() { PENDING+=("$1"); }
# Not '|': a description may contain one (the SMTP relay's `"tls"|"starttls"` did, and the
# report cut it off there).
US=$'\x1f'
human() { HUMAN+=("$1$US$2"); }

# ---------------------------------------------------------------------------------------------
# Identities
# ---------------------------------------------------------------------------------------------

USERS=(kf-api kf-web kf-worker kf-migrator kf-checkpoint kf-backup kf-offsite kf-readiness
  kf-storage kf-audit-verify kf-alert kf-drill kf-attestor kf-retrieval-key kf-embedding kf-retrieval
  kf-tls kf-objects kf-objects-init kf-notify)

# Numeric ids from the account database, root included, so ownership is compared as the kernel
# records it.
owner_uid() { getent passwd "$1" | cut -d: -f3; }
gid_of() { getent group "$1" | cut -d: -f3; }

ensure_user() {
  if getent passwd "$1" >/dev/null; then return 0; fi
  if [ "$MODE" = check ]; then pending "user $1"; return 0; fi
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin "$1"
  created "user $1"
}

ensure_archive_group() {
  # Written by kf-backup, read by kf-offsite to ship it. The drill pulls from off-site instead.
  if ! getent group kf-archive >/dev/null; then
    if [ "$MODE" = check ]; then
      pending "group kf-archive"
    else
      groupadd --system kf-archive
      created "group kf-archive"
    fi
  fi
  for member in kf-backup kf-offsite; do
    if getent group kf-archive | cut -d: -f4 | tr ',' '\n' | grep -qx "$member"; then continue; fi
    if [ "$MODE" = check ]; then pending "$member in group kf-archive"; continue; fi
    usermod -aG kf-archive "$member"
    created "$member in group kf-archive"
  done
}

ensure_attest_group() {
  # The attestor's socket group (20260924001000): kf-attestor serves on it, kf-api alone may
  # connect. Nobody else is a member, so nothing else can ask for an attestation.
  if ! getent group kf-attest >/dev/null; then
    if [ "$MODE" = check ]; then
      pending "group kf-attest"
    else
      groupadd --system kf-attest
      created "group kf-attest"
    fi
  fi
  for member in kf-attestor kf-api; do
    if getent group kf-attest | cut -d: -f4 | tr ',' '\n' | grep -qx "$member"; then continue; fi
    if [ "$MODE" = check ]; then pending "$member in group kf-attest"; continue; fi
    usermod -aG kf-attest "$member"
    created "$member in group kf-attest"
  done
}

ensure_retrieval_group() {
  # Unix filesystem access and kernel peer admission are separate checks. Only the
  # declared API and worker identities may traverse the engine's runtime directory.
  for member in kf-api kf-worker; do
    if getent group kf-retrieval | cut -d: -f4 | tr ',' '\n' | grep -qx "$member"; then continue; fi
    if [ "$MODE" = check ]; then pending "$member in group kf-retrieval"; continue; fi
    usermod -aG kf-retrieval "$member"
    created "$member in group kf-retrieval"
  done
}

# ---------------------------------------------------------------------------------------------
# Directories and files
# ---------------------------------------------------------------------------------------------

# mode owner group path
DIRECTORIES=(
  "0755 root root /etc/kf"
  "0750 root kf-api /etc/kf/api"
  "0750 root kf-web /etc/kf/web"
  "0750 root kf-worker /etc/kf/worker"
  "0750 root kf-migrator /etc/kf/migrator"
  "0750 root kf-checkpoint /etc/kf/checkpoint"
  "0750 root kf-backup /etc/kf/backup"
  "0750 root kf-offsite /etc/kf/offsite"
  "0750 root kf-readiness /etc/kf/readiness"
  "0750 root kf-storage /etc/kf/storage"
  "0750 root kf-audit-verify /etc/kf/audit-verify"
  "0750 root kf-alert /etc/kf/alert"
  "0750 root kf-notify /etc/kf/notify"
  "0750 root kf-drill /etc/kf/drill"
  "0700 kf-attestor kf-attestor /etc/kf/attestor"
  "0700 kf-objects kf-objects /etc/kf/objects"
  "0700 kf-objects-init kf-objects-init /etc/kf/objects-init"
  "0700 kf-objects kf-objects /var/lib/kf-objects"
  "0700 root root /etc/kf/credstore.encrypted"
  "0755 root root /etc/kf/preservation-trust.d"
  "0755 root root /etc/kf/checkpoint-public-keys"
  "0750 kf-tls kf-tls /etc/kf/tls"
  "0700 kf-worker kf-worker /var/lib/kf-worker"
  "0700 kf-migrator kf-migrator /var/lib/kf-migrator"
  "2750 kf-backup kf-archive /srv/kf-backups"
  # kf-commissioning's KF_EVIDENCE_DIR: install-release.sh (root) writes the release-verification
  # receipt, migrate-release.sh rehearse-rollback (kf-migrator) the rollback-rehearsal one.
  "0755 root root /var/lib/kf"
  "0775 root kf-migrator /var/lib/kf/commissioning"
)

mode_of() { stat -c '%a' -- "$1"; }

ensure_dir() {
  local mode="$1" owner="$2" group="$3" path="$4" actual
  actual="$(p "$path")"
  if [ -d "$actual" ]; then
    # Owner before mode: a chown may clear set-id bits, so the mode is applied last.
    if [ "$(stat -c '%u:%g' -- "$actual")" != "$(owner_uid "$owner"):$(gid_of "$group")" ]; then
      if [ "$MODE" = check ]; then
        pending "$path owned by $owner:$group"
      else
        chown "$owner:$group" "$actual"
        created "$path owner $owner:$group"
      fi
    fi
    if [ "$(mode_of "$actual")" != "${mode#0}" ]; then
      if [ "$MODE" = check ]; then
        pending "$path mode $(mode_of "$actual"), expected $mode"
      else
        chmod "$mode" "$actual"
        created "$path mode $mode"
      fi
    fi
    return 0
  fi
  if [ "$MODE" = check ]; then pending "directory $path"; return 0; fi
  mkdir -p -- "$actual"
  chown "$owner:$group" "$actual"
  chmod "$mode" "$actual"
  created "directory $path"
}

# The owner-only posture every secret file must have. Reported, never silently "fixed": a
# secret found readable by others has already been disclosed, and a person should know.
check_secret_posture() {
  local owner="$1" path="$2" actual mode
  actual="$(p "$path")"
  mode="$(mode_of "$actual")"
  if [ $((8#$mode & 8#077)) -ne 0 ]; then
    human "$path" "is mode $mode — readable beyond its owner, so treat it as disclosed: replace it, then chmod 600"
  fi
  if [ "$(stat -c '%u' -- "$actual")" != "$(owner_uid "$owner")" ]; then
    if [ "$MODE" = check ]; then pending "$path owned by $owner"; else chown "$owner:$owner" "$actual"; created "$path owner $owner"; fi
  fi
}

# A secret only a person can supply: create the empty owner-only file it goes in, so the only
# remaining step is writing its value, and report it while it is empty.
ensure_human_secret() {
  local owner="$1" path="$2" what="$3" actual
  actual="$(p "$path")"
  if [ ! -e "$actual" ]; then
    if [ "$MODE" = check ]; then
      pending "empty owner-only placeholder $path"
    else
      : > "$actual"
      chmod 600 "$actual"
      chown "$owner:$owner" "$actual"
      created "placeholder $path (0600 $owner)"
    fi
    human "$path" "$what"
    return 0
  fi
  check_secret_posture "$owner" "$path"
  [ -s "$actual" ] || human "$path" "$what"
}

# A secret a machine can make. Bytes go from /dev/urandom through a pipe into a file created
# 0600 by this shell; nothing about them reaches argv, the environment or the output.
generate_secret() {
  local owner="$1" path="$2" kind="$3" actual
  actual="$(p "$path")"
  if [ -s "$actual" ]; then
    check_secret_posture "$owner" "$path"
    return 0
  fi
  if [ "$MODE" = check ]; then pending "generated secret $path"; return 0; fi
  : > "$actual"
  chmod 600 "$actual"
  case "$kind" in
    raw32) head -c 32 /dev/urandom > "$actual" ;;
    # Canonical base64 of exactly 32 bytes, which is what the web session key must be.
    base64-32) head -c 32 /dev/urandom | base64 -w0 > "$actual" ;;
    # 48 random bytes as base64: 64 printable characters, comfortably over the 32 required.
    token) head -c 48 /dev/urandom | base64 -w0 > "$actual" ;;
    *) echo "provision-host: unknown secret kind $kind" >&2; exit 70 ;;
  esac
  chown "$owner:$owner" "$actual"
  created "generated $path (0600 $owner)"
}

is_placeholder() {
  [[ "$1" =~ replace-with|replace-me|\.example\.internal|\.example\.invalid|RELEASE_ID ]]
}

# Set KEY in an env file only when it is absent, empty or a placeholder (or always, with a
# fourth argument `force`). `cat >` rewrites the file in place, so its owner and mode are kept.
set_env_value() {
  local file="$1" key="$2" value="$3" force="${4:-}" current tmp
  current="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true)"
  if [ "$force" != force ] && grep -qE "^${key}=" "$file" && [ -n "$current" ] &&
     ! is_placeholder "$current"; then
    return 0
  fi
  [ "$current" != "$value" ] || return 0
  tmp="$(mktemp)"
  if grep -qE "^${key}=" "$file"; then
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' \
      "$file" > "$tmp"
  elif grep -qE "^# *${key}=" "$file"; then
    awk -v k="$key" -v v="$value" '
      !done && $0 ~ "^# *" k "=" { print k "=" v; done = 1; next } { print }' "$file" > "$tmp"
  else
    cat "$file" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$file"
  rm -f -- "$tmp"
  created "$file: $key"
}

env_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true
}

# template destination mode owner group
ENV_FILES=(
  "api.env.example /etc/kf/api.env 0640 root kf-api"
  "web.env.example /etc/kf/web.env 0640 root kf-web"
  "worker.env.example /etc/kf/worker.env 0640 root kf-worker"
  "migrator.env.example /etc/kf/migrator.env 0640 root kf-migrator"
  "backup.env.example /etc/kf/backup.env 0640 root kf-backup"
  "checkpoint.env.example /etc/kf/checkpoint.env 0640 root kf-checkpoint"
  "offsite.env.example /etc/kf/offsite.env 0640 root kf-offsite"
  "drill.env.example /etc/kf/drill.env 0640 root kf-drill"
  "attestor.env.example /etc/kf/attestor.env 0640 root kf-attestor"
  "tailnet.env.example /etc/kf/tailnet.env 0640 root kf-tls"
  "storage.env.example /etc/kf/storage/storage.env 0600 kf-storage kf-storage"
  "objects.env.example /etc/kf/objects-init/objects.env 0600 kf-objects-init kf-objects-init"
  "notify.env.example /etc/kf/notify.env 0640 root kf-notify"
  "database.env.example /etc/kf/database.env 0600 root root"
)

# Keys whose empty value is an unconfigured deployment rather than an opted-out feature.
REQUIRED_NONEMPTY=" KF_OFFSITE_DESTINATION KF_OFFSITE_LABEL KF_DRILL_OFFSITE_SOURCE KF_DRILL_OFFSITE_LABEL CHECKPOINT_S3_ENDPOINT CHECKPOINT_S3_REGION CHECKPOINT_S3_ACCESS_KEY_ID "

ensure_env_file() {
  local template="$1" path="$2" mode="$3" owner="$4" group="$5" actual
  actual="$(p "$path")"
  if [ ! -f "$actual" ]; then
    if [ "$MODE" = check ]; then pending "$path from deploy/systemd/$template"; return 0; fi
    cat "$TEMPLATES/$template" > "$actual"
    chmod "$mode" "$actual"
    chown "$owner:$group" "$actual"
    created "$path from $template ($mode $owner:$group)"
  fi
}

# Where the PostgreSQL 18 client lives: /usr/bin when that psql is 18, else Debian's versioned
# directory. Empty when neither is.
postgres_client_dir() {
  local dir
  for dir in /usr/bin /usr/lib/postgresql/18/bin; do
    if [ -x "$(p "$dir")/psql" ] &&
       [[ "$("$(p "$dir")/psql" --version 2>/dev/null)" =~ \(PostgreSQL\)[[:space:]]+18([.]|$) ]]; then
      printf '%s' "$dir"
      return 0
    fi
  done
}

# Copy the artifacts store's routing from api.env into a file that still carries the template's
# placeholder endpoint. Endpoint, region, bucket and path style move together or not at all:
# half of one store's routing and half of another's names no store. Never the access-key id,
# which is a different key per identity.
inherit_store_routing() {
  local dest="$1" source value name
  source="$(p /etc/kf/api.env)"
  [ -f "$source" ] && [ -f "$(p "$dest")" ] || return 0
  value="$(env_value "$source" S3_ENDPOINT)"
  [ -n "$value" ] && ! is_placeholder "$value" || return 0
  [ "$value" != "$LOCAL_OBJECTS" ] || return 0
  value="$(env_value "$(p "$dest")" S3_ENDPOINT)"
  # The template's own default (this host's kf-objects) gives way to the store api.env names;
  # anything else in the file is an operator's choice and is kept.
  [ -z "$value" ] || is_placeholder "$value" || [ "$value" = "$LOCAL_OBJECTS" ] || return 0
  if [ "$MODE" = check ]; then pending "$dest: S3 routing, copied from /etc/kf/api.env"; return 0; fi
  for name in S3_ENDPOINT S3_REGION S3_BUCKET_ARTIFACTS S3_FORCE_PATH_STYLE; do
    value="$(env_value "$source" "$name")"
    [ -z "$value" ] || set_env_value "$(p "$dest")" "$name" "$value" force
  done
}

# The attestor verifies the same tokens the API was configured for: copy the three OIDC values
# over any template placeholder, never over a value an operator set.
inherit_oidc() {
  local dest source value name current
  source="$(p /etc/kf/api.env)"
  dest="$(p /etc/kf/attestor.env)"
  [ -f "$source" ] && [ -f "$dest" ] || return 0
  for name in OIDC_ISSUER OIDC_AUDIENCE OIDC_JWKS_URI; do
    value="$(env_value "$source" "$name")"
    [ -n "$value" ] && ! is_placeholder "$value" || continue
    current="$(env_value "$dest" "$name")"
    [ -z "$current" ] || is_placeholder "$current" || continue
    if [ "$MODE" = check ]; then pending "/etc/kf/attestor.env: $name, copied from /etc/kf/api.env"; continue; fi
    set_env_value "$dest" "$name" "$value" force
  done
  # The web's sign-in goes to the same issuer the API verifies tokens from.
  value="$(env_value "$source" OIDC_ISSUER)"
  [ -n "$value" ] && ! is_placeholder "$value" || return 0
  fill_env_value /etc/kf/web.env KF_WEB_OIDC_ISSUER "$value"
}

# The detected and defaulted values. Only ever fills a gap.
complete_env_files() {
  local backup offsite client name value
  backup="$(p /etc/kf/backup.env)"
  offsite="$(p /etc/kf/offsite.env)"
  client="$(postgres_client_dir)"
  if [ -z "$client" ]; then
    human "PostgreSQL 18 client" "install it (Debian/Ubuntu: postgresql-client-18); the backup, drill and off-site scripts refuse any other major version"
  fi
  if [ "$MODE" = apply ] && [ -n "$client" ]; then
    for file in "$backup" "$offsite"; do
      [ -f "$file" ] || continue
      value="$(env_value "$file" KF_POSTGRES_CLIENT_DIR)"
      # Only a value this script can see is wrong: the template's /usr/bin where that is not 18.
      if [ -z "$value" ] || { [ "$value" = /usr/bin ] && [ "$client" != /usr/bin ]; }; then
        set_env_value "$file" KF_POSTGRES_CLIENT_DIR "$client" force
      fi
    done
  fi
  # The drill pulls back what the off-site job sent: default its source and label to those.
  if [ -f "$backup" ] && [ -f "$offsite" ]; then
    for name in DESTINATION:SOURCE LABEL:LABEL; do
      value="$(env_value "$offsite" "KF_OFFSITE_${name%%:*}")"
      [ -n "$value" ] && ! is_placeholder "$value" || continue
      [ -z "$(env_value "$backup" "KF_DRILL_OFFSITE_${name##*:}")" ] || continue
      if [ "$MODE" = check ]; then
        pending "/etc/kf/backup.env: KF_DRILL_OFFSITE_${name##*:}, copied from /etc/kf/offsite.env"
      else
        set_env_value "$backup" "KF_DRILL_OFFSITE_${name##*:}" "$value"
      fi
    done
  fi
  inherit_store_routing /etc/kf/drill.env
  inherit_store_routing /etc/kf/worker.env
  inherit_store_routing /etc/kf/storage/storage.env
  inherit_oidc
}

# " path:KEY " for every value --check found this script would fill, so it is not ALSO listed as
# a placeholder only a person can replace.
WOULD_FILL=" "

report_env_placeholders() {
  local entry template path mode owner group actual key value
  for entry in "${ENV_FILES[@]}"; do
    read -r template path mode owner group <<< "$entry"
    actual="$(p "$path")"
    [ -f "$actual" ] || continue
    while IFS= read -r line; do
      [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      [[ "$WOULD_FILL" != *" $path:$key "* ]] || continue
      # The compiler pins are check_liminal_declaration's: whether they belong at all depends on
      # what the release declares.
      [[ "$path:$key" != /etc/kf/worker.env:LIMINAL_* ]] || continue
      if is_placeholder "$value"; then
        human "$path" "$key (still the template's placeholder: $value)"
      elif [ -z "$value" ] && [[ "$REQUIRED_NONEMPTY" == *" $key "* ]]; then
        human "$path" "$key (empty; the unit refuses or fails without it)"
      fi
    done < "$actual"
  done
}

# Fill KEY in an env file with a value this script derived, or, in --check, say it would.
fill_env_value() {
  local path="$1" key="$2" value="$3" force="${4:-}" current
  [ -f "$(p "$path")" ] || return 0
  current="$(env_value "$(p "$path")" "$key")"
  [ "$current" != "$value" ] || return 0
  if [ "$force" != force ] && [ -n "$current" ] && ! is_placeholder "$current"; then return 0; fi
  if [ "$MODE" = check ]; then
    pending "$path: $key=$value"
    WOULD_FILL+="$path:$key "
  else
    set_env_value "$(p "$path")" "$key" "$value" force
  fi
}

# The migration unit's two release-specific values, from the release that is live. Both were
# placeholders a person copied by hand; the digest is the one install-release.sh verified the
# tree against and recorded (/opt/.kf-install/<release>.verified), and the receipt path is named
# by the release id. Replaced whenever the live release changes: "never reuse digest/receipt
# values for another release" (migrator.env.example) is a rule a machine keeps better.
complete_migrator_env() {
  local name record digest
  name="$(basename -- "$(readlink -f -- "$RELEASE")")"
  record="$(p /opt/.kf-install)/$name.verified"
  [ -f "$record" ] || return 0
  digest="$(grep -E '^manifest_sha256=' "$record" | cut -d= -f2-)"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 0
  fill_env_value /etc/kf/migrator.env KF_EXPECTED_RELEASE_MANIFEST_SHA256 "$digest" force
  fill_env_value /etc/kf/migrator.env KF_ROLLBACK_REHEARSAL_RECEIPT \
    "/var/lib/kf-migrator/rollback-rehearsal-${name#knowledge-fabric-}.receipt" force
}

# The release says whether it carries a compiler (BUILD-METADATA liminal=none|sealed), and the
# worker's ExecStartPre (verify-liminal-runtime.sh) refuses a worker.env that disagrees: with
# liminal=none ANY LIMINAL_* value is refused, and the worker never starts. Until 2026-10-07 the
# template set all seven, three of them placeholders, so the ordinary release's worker could not
# start from it, and this script asked a person to invent three digests for a compiler that does
# not exist.
LIMINAL_KEYS=(LIMINAL_COMPILER_PATH LIMINAL_CARGO_LOCK_PATH LIMINAL_EXECUTABLE_SHA256
  LIMINAL_CARGO_LOCK_SHA256 LIMINAL_RUNTIME_CLOSURE_SHA256 LIMINAL_BWRAP_PATH
  LIMINAL_RUNTIME_FILE_PATHS)
check_liminal_declaration() {
  local env declared name set=() unset=()
  env="$(p /etc/kf/worker.env)"
  [ -f "$env" ] || return 0
  [ -f "$RELEASE/BUILD-METADATA" ] || return 0
  declared="$(sed -n 's/^liminal=//p' "$RELEASE/BUILD-METADATA" | head -n 1)"
  for name in "${LIMINAL_KEYS[@]}"; do
    if grep -qE "^${name}=" "$env"; then set+=("$name"); else unset+=("$name"); fi
  done
  case "$declared" in
    none)
      [ "${#set[@]}" -eq 0 ] ||
        human /etc/kf/worker.env "the release declares liminal=none, so comment out ${set[*]}: the worker refuses to start with any of them set (verify-liminal-runtime.sh)"
      ;;
    sealed)
      [ "${#unset[@]}" -eq 0 ] ||
        human /etc/kf/worker.env "the release seals a Liminal compiler: set ${unset[*]} from /opt/kf/vendor/liminal/RUNTIME.env"
      for name in "${set[@]}"; do
        is_placeholder "$(env_value "$env" "$name")" &&
          human /etc/kf/worker.env "$name (still the template's placeholder; the pin is in /opt/kf/vendor/liminal/RUNTIME.env)"
      done
      ;;
  esac
  return 0
}

# The urgent push travels the alert path: its endpoint IS the alert webhook (notify.env.example),
# so once a person has supplied that one, this copy is a machine's to make.
copy_alert_webhook_for_notify() {
  local source target
  source="$(p /etc/kf/alert/webhook-url)"
  target="$(p /etc/kf/notify/alert-webhook-url)"
  [ -s "$source" ] && [ -d "$(dirname -- "$target")" ] || return 0
  [ ! -s "$target" ] || return 0
  if [ "$MODE" = check ]; then pending "/etc/kf/notify/alert-webhook-url, copied from /etc/kf/alert/webhook-url"; return 0; fi
  [ -e "$target" ] || : > "$target"
  chmod 600 "$target"
  cat -- "$source" > "$target"
  chown kf-notify:kf-notify "$target"
  created "/etc/kf/notify/alert-webhook-url, copied from /etc/kf/alert/webhook-url (0600 kf-notify)"
}

# An rsync off-site destination on another host (user@host:/path) is reached over ssh, as the
# identity that copies (kf-offsite) and the one that pulls it back (kf-drill). Both have no home
# (/nonexistent) and run with ProtectHome=, so ssh found no key and no known_hosts and every copy
# failed with "Host key verification failed" — nothing anywhere said where either should come
# from (2026-10-07 rehearsal). Each identity gets its own key, made here; ssh is told where it
# and the pinned host key are; and the destination is asked, as that identity, whether it lets
# it in. What only a person can do is named: pin the destination's host key, authorize the key.
#
# identity|env file|variable|directory
RSYNC_IDENTITIES=(
  "kf-offsite|/etc/kf/offsite.env|KF_OFFSITE_DESTINATION|/etc/kf/offsite"
  "kf-drill|/etc/kf/backup.env|KF_DRILL_OFFSITE_SOURCE|/etc/kf/drill"
)
RSYNC_SSH_CONFIG=/etc/ssh/ssh_config.d/kf-offsite.conf

rsync_ssh_config() {
  local entry identity env variable dir
  echo '# Written by /opt/kf/scripts/deploy/provision-host.sh: where each off-site identity finds its'
  echo '# ssh key and the pinned host key of its destination. Regenerated; do not edit.'
  for entry in "${RSYNC_IDENTITIES[@]}"; do
    IFS='|' read -r identity env variable dir <<< "$entry"
    printf 'Match localuser %s\n' "$identity"
    printf '    IdentityFile %s/ssh-key\n    IdentitiesOnly yes\n' "$dir"
    printf '    UserKnownHostsFile %s/known_hosts\n' "$dir"
    printf '    StrictHostKeyChecking yes\n    BatchMode yes\n'
  done
}

ensure_rsync_identities() {
  local entry identity env variable dir destination host key work remote=0
  for entry in "${RSYNC_IDENTITIES[@]}"; do
    IFS='|' read -r identity env variable dir <<< "$entry"
    destination="$(env_value "$(p "$env")" "$variable")"
    case "$destination" in b2 | '' | /*) continue ;; *:*) ;; *) continue ;; esac
    [ -d "$(p "$dir")" ] || continue
    remote=1
    host="${destination%%:*}"
    key="$(p "$dir/ssh-key")"
    if [ ! -s "$key" ]; then
      if [ "$MODE" = check ]; then
        pending "ssh key $dir/ssh-key for $identity (to reach $host)"
      else
        # ssh-keygen writes the private key itself, 0600; it never passes through this shell.
        work="$(mktemp -d)"
        ssh-keygen -q -t ed25519 -N '' -C "$identity@$(hostname -s 2>/dev/null || echo host)" \
          -f "$work/ssh-key"
        install -m 0600 "$work/ssh-key" "$key"
        install -m 0644 "$work/ssh-key.pub" "$key.pub"
        rm -rf -- "$work"
        chown "$identity:$identity" "$key"
        created "ssh key $dir/ssh-key (0600 $identity); its public half is $dir/ssh-key.pub"
      fi
    else
      check_secret_posture "$identity" "$dir/ssh-key"
    fi
    if [ ! -s "$(p "$dir/known_hosts")" ]; then
      human "$dir/known_hosts" "the host key of ${host#*@}, pinned for $identity: ssh-keyscan it from this host, compare the fingerprint with one read on that host's own console, then write the line here (0644)"
      continue
    fi
    # Asked as the identity, through the same config the unit will use. Only when everything
    # this script can make exists: before that the answer says nothing about the destination.
    if [ -s "$key" ] && [ -z "$PREFIX" ] && [ -f "$RSYNC_SSH_CONFIG" ]; then
      if ! runuser -u "$identity" -- ssh -o ConnectTimeout=10 "$host" true </dev/null >/dev/null 2>&1; then
        human "$host" "does not let $identity in: add $dir/ssh-key.pub to that account's authorized_keys (for $identity it may be read-only; see docs/deployment/backup-custody.md)"
      fi
    fi
  done
  [ "$remote" = 1 ] || return 0
  if [ ! -f "$(p "$RSYNC_SSH_CONFIG")" ] || [ "$(cat "$(p "$RSYNC_SSH_CONFIG")")" != "$(rsync_ssh_config)" ]; then
    if [ "$MODE" = check ]; then
      pending "$RSYNC_SSH_CONFIG (each off-site identity's key and pinned host key)"
    else
      mkdir -p -- "$(p "$(dirname -- "$RSYNC_SSH_CONFIG")")"
      rsync_ssh_config > "$(p "$RSYNC_SSH_CONFIG")"
      chmod 644 "$(p "$RSYNC_SSH_CONFIG")"
      created "$RSYNC_SSH_CONFIG"
    fi
  fi
}

# Sockets on the public interface that are not KF's but fail its public_exposure check. On the
# Debian 13 cloud image the rehearsal (2026-10-07) found two: systemd-resolved's LLMNR on every
# address (5355/tcp+udp), which nothing on a tailnet host uses, and sshd on 0.0.0.0:22 and [::]:22.
RESOLVED_DROPIN=/etc/systemd/resolved.conf.d/kf-no-llmnr.conf
ensure_public_sockets_closed() {
  local wanted current sshd_listen
  wanted=$'# Written by /opt/kf/scripts/deploy/provision-host.sh: no name service on the public\n# interface (kf-commissioning public_exposure).\n[Resolve]\nLLMNR=no\nMulticastDNS=no'
  if [ -x "$(p /usr/lib/systemd/systemd-resolved)" ]; then
    current="$(cat "$(p "$RESOLVED_DROPIN")" 2>/dev/null || true)"
    if [ "$current" != "$wanted" ]; then
      if [ "$MODE" = check ]; then
        pending "$RESOLVED_DROPIN (LLMNR and mDNS off: systemd-resolved listens for them on every address)"
      else
        install -d -m 0755 -- "$(p "$(dirname -- "$RESOLVED_DROPIN")")"
        printf '%s\n' "$wanted" > "$(p "$RESOLVED_DROPIN")"
        chmod 644 "$(p "$RESOLVED_DROPIN")"
        [ -n "$PREFIX" ] || systemctl try-restart systemd-resolved.service || true
        created "$RESOLVED_DROPIN (LLMNR and mDNS off)"
      fi
    fi
  fi
  # sshd is the operator's door, so it is reported, never moved: binding it to the tailnet
  # address is right only once `ssh <host>.<tailnet>.ts.net` works, and the provider console is
  # the way back in if the tailnet is down.
  if [ -z "$PREFIX" ] && [ -x /usr/sbin/sshd ]; then
    sshd_listen="$(/usr/sbin/sshd -T 2>/dev/null | awk '$1 == "listenaddress" { print $2 }' |
      grep -E '^(0\.0\.0\.0|\[::\]):' | tr '\n' ' ' || true)"
    if [ -n "$sshd_listen" ]; then
      human "sshd (/etc/ssh/sshd_config.d/)" "listens on ${sshd_listen% }, every address; kf-commissioning's public_exposure refuses it. Once ssh over the tailnet name works, add \`ListenAddress <tailnet IPv4>\` in a sshd_config.d file and restart ssh (keep the provider console as the second way in), or decide to keep it public and say so in the commissioning record"
    fi
  fi
}

# ---------------------------------------------------------------------------------------------
# The checkpoint signing key: made here, published first, named by its own fingerprint
# ---------------------------------------------------------------------------------------------

# The id is derived from the key (ckpt-<first 16 hex of SHA-256 over its public key>), so a new
# key always gets a new id — the rotation rule the signer enforces — without anybody choosing.
# The public half goes into the trust directory BEFORE the id is configured, as `--run` requires.
ensure_checkpoint_key() {
  local key pubdir env configured derived write=0
  key="$(p /etc/kf/checkpoint/checkpoint-key)"
  pubdir="$(p /etc/kf/checkpoint-public-keys)"
  env="$(p /etc/kf/checkpoint.env)"
  if [ ! -s "$key" ]; then
    if [ "$MODE" = check ]; then
      pending "checkpoint signing key /etc/kf/checkpoint/checkpoint-key, its public half and CHECKPOINT_SIGNING_KEY_ID"
      return 0
    fi
    : > "$key"
    chmod 600 "$key"
    # Written by Node from inside the process: the private key never passes through this shell.
    "$NODE" -e '
      const { generateKeyPairSync } = require("node:crypto");
      const { writeFileSync } = require("node:fs");
      const { privateKey } = generateKeyPairSync("ed25519");
      writeFileSync(process.argv[1], privateKey.export({ format: "pem", type: "pkcs8" }));
    ' "$key"
    chown kf-checkpoint:kf-checkpoint "$key"
    created "checkpoint signing key /etc/kf/checkpoint/checkpoint-key (0600 kf-checkpoint)"
  else
    check_secret_posture kf-checkpoint /etc/kf/checkpoint/checkpoint-key
  fi
  [ -f "$env" ] || return 0
  configured="$(env_value "$env" CHECKPOINT_SIGNING_KEY_ID)"
  if is_placeholder "$configured"; then configured=""; fi
  [ "$MODE" = apply ] && write=1
  # The id and the public half come from whatever key is installed — generated just now or
  # supplied by a person — never from a value somebody typed. A configured id is kept; only its
  # missing .pub is written, from the key itself.
  if ! derived="$("$NODE" -e '
      const { createHash, createPrivateKey, createPublicKey } = require("node:crypto");
      const { chmodSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
      const [keyPath, pubdir, configured, write] = process.argv.slice(1);
      const publicKey = createPublicKey(createPrivateKey(readFileSync(keyPath)));
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
      const id = configured || "ckpt-" + createHash("sha256")
        .update(publicKey.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16);
      const pub = `${pubdir}/${id}.pub`;
      if (!existsSync(pub)) {
        if (write !== "1") { process.stdout.write(`missing:${id}`); process.exit(0); }
        writeFileSync(pub, publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644 });
        // `mode` is filtered through the umask 077 set above: without the chmod the public half
        // was 0600 root and the signer, running as kf-checkpoint, could not read it (EACCES on the
        // first checkpoint of the 2026-10-07 rehearsal).
        chmodSync(pub, 0o644);
        process.stdout.write(`published:${id}`);
        process.exit(0);
      }
      // A public half published 0600 by an earlier run is made readable; it is public.
      if (write === "1") chmodSync(pub, 0o644);
      process.stdout.write(`present:${id}`);
    ' "$key" "$pubdir" "$configured" "$write" 2>/dev/null)"; then
    human /etc/kf/checkpoint/checkpoint-key "is not a readable Ed25519 private key (PKCS#8 PEM)"
    return 0
  fi
  case "$derived" in
    missing:*) pending "checkpoint public key /etc/kf/checkpoint-public-keys/${derived#missing:}.pub" ;;
    published:*) created "checkpoint public key /etc/kf/checkpoint-public-keys/${derived#published:}.pub" ;;
  esac
  if [ -z "$configured" ]; then
    if [ "$MODE" = check ]; then
      pending "CHECKPOINT_SIGNING_KEY_ID=${derived#*:} in /etc/kf/checkpoint.env"
    else
      set_env_value "$env" CHECKPOINT_SIGNING_KEY_ID "${derived#*:}"
    fi
  fi
}

# ---------------------------------------------------------------------------------------------
# The backup recovery key and the drill's sealed credential
# ---------------------------------------------------------------------------------------------

seal_for_drill() {
  # systemd-creds reads the key file itself and writes ciphertext bound to this host. Only the
  # two paths are arguments.
  systemd-creds encrypt --name=backup-decryption-key "$1" \
    "$(p /etc/kf/credstore.encrypted/backup-decryption-key)"
  chmod 600 "$(p /etc/kf/credstore.encrypted/backup-decryption-key)"
  created "sealed drill credential /etc/kf/credstore.encrypted/backup-decryption-key"
}

ensure_recovery_key() {
  local recipient sealed home fingerprint
  recipient="$(p /etc/kf/backup-recipient.asc)"
  sealed="$(p /etc/kf/credstore.encrypted/backup-decryption-key)"
  if [ -n "$RECOVERY_OUT" ] && [ "$MODE" = apply ]; then
    if [ -s "$recipient" ] || [ -s "$sealed" ]; then
      echo "provision-host: refusing --generate-recovery-key: a recipient key or sealed credential already exists" >&2
      exit 1
    fi
    [ ! -e "$RECOVERY_OUT" ] || { echo "provision-host: $RECOVERY_OUT exists; refusing to overwrite it" >&2; exit 1; }
    home="$(mktemp -d)"
    # shellcheck disable=SC2064  # the path is fixed now
    trap "rm -rf -- '$home'" EXIT
    gpg --batch --no-tty --quiet --homedir "$home" --passphrase '' \
      --quick-gen-key "Knowledge Fabric backup recovery <kf-recovery@$(hostname -s 2>/dev/null || echo host)>" ed25519 sign never
    fingerprint="$(gpg --batch --no-tty --homedir "$home" --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')"
    gpg --batch --no-tty --quiet --homedir "$home" --passphrase '' \
      --quick-add-key "$fingerprint" cv25519 encr never
    gpg --batch --no-tty --homedir "$home" --armor --export > "$recipient"
    chmod 644 "$recipient"
    ( umask 077
      gpg --batch --no-tty --homedir "$home" --pinentry-mode loopback --passphrase '' \
        --armor --export-secret-keys > "$RECOVERY_OUT" )
    seal_for_drill "$RECOVERY_OUT"
    rm -rf -- "$home"
    trap - EXIT
    created "backup recipient /etc/kf/backup-recipient.asc (fingerprint $fingerprint)"
    human "$RECOVERY_OUT" "the recovery SECRET key, written once: move it to the recovery custodian's offline custody, then delete it here (shred -u)"
    return 0
  fi
  if [ -n "$SEAL_KEY" ] && [ "$MODE" = apply ]; then
    [ -f "$SEAL_KEY" ] || { echo "provision-host: $SEAL_KEY is not a file" >&2; exit 1; }
    seal_for_drill "$SEAL_KEY"
  fi
  if [ ! -s "$recipient" ]; then
    human /etc/kf/backup-recipient.asc "the recovery custodian's OpenPGP PUBLIC key (0644 root) — or re-run with --generate-recovery-key <file>"
  fi
  if [ ! -s "$sealed" ]; then
    human /etc/kf/credstore.encrypted/backup-decryption-key "the drill's decryption credential: re-run with --seal-drill-key <recovery-secret-key.asc>"
  fi
}

# ---------------------------------------------------------------------------------------------
# The object store: orphan-collection permissions for the storage key
# ---------------------------------------------------------------------------------------------

storage_ready() {
  local env secret name value
  env="$(p /etc/kf/storage/storage.env)"
  secret="$(p /etc/kf/storage/s3-secret)"
  [ -f "$env" ] && [ -s "$secret" ] || return 1
  for name in S3_ENDPOINT S3_ACCESS_KEY_ID S3_BUCKET_ARTIFACTS KF_STORAGE_ORGANIZATION; do
    value="$(env_value "$env" "$name")"
    [ -n "$value" ] && ! is_placeholder "$value" || return 1
  done
}

render_policy() {
  sed "s/KF_ARTIFACTS_BUCKET/$1/g" "$POLICY_TEMPLATE"
}

ensure_storage_policy() {
  local env bucket key endpoint
  env="$(p /etc/kf/storage/storage.env)"
  bucket="$(env_value "$env" S3_BUCKET_ARTIFACTS)"
  key="$(env_value "$env" S3_ACCESS_KEY_ID)"
  endpoint="$(env_value "$env" S3_ENDPOINT)"
  if [ -z "$bucket" ] || is_placeholder "$bucket"; then bucket='<artifacts bucket>'; fi
  if [ -z "$key" ] || is_placeholder "$key"; then key='<S3_ACCESS_KEY_ID in /etc/kf/storage/storage.env>'; fi
  # This host's own store grants the policy in its identities (ensure_local_objects); any other
  # store is administered elsewhere, so the policy is printed for whoever administers it.
  if [ "$MODE" = apply ] && [ "$endpoint" != "$LOCAL_OBJECTS" ]; then POLICY_TO_PRINT="$bucket|$key"; fi
  # Whether granted here or by hand, ask the store — as kf-storage, with its own files.
  if storage_ready; then probe_storage_permissions "$bucket" "$key"; fi
}

probe_storage_permissions() {
  local bucket="$1" key="$2" main output
  main="$RELEASE/apps/kf-storage/dist/main.js"
  if [ ! -f "$main" ] || [ ! -x "$NODE" ]; then
    pending "probe of the storage key's permissions (needs $main and $NODE)"
    return 0
  fi
  if output="$(runuser -u kf-storage -- env -i PATH=/usr/bin:/bin NODE_ENV=production \
      S3_SECRET_ACCESS_KEY_FILE="$(p /etc/kf/storage/s3-secret)" \
      "$NODE" --env-file="$(p /etc/kf/storage/storage.env)" "$main" --check-permissions 2>&1)"; then
    return 0
  fi
  human "object-store policy for $key" "$(printf '%s' "$output" | grep -m1 'refused' || printf 'the permission probe failed: %s' "$output" | head -c 400)"
  if [ "$(env_value "$(p /etc/kf/storage/storage.env)" S3_ENDPOINT)" != "$LOCAL_OBJECTS" ]; then
    POLICY_TO_PRINT="$bucket|$key"
  fi
}

# ---------------------------------------------------------------------------------------------
# This host's object store: kf-objects, SeaweedFS on loopback (ADR 0039)
# ---------------------------------------------------------------------------------------------

# The pinned SeaweedFS binary, fetched and checked twice: the tarball's sha256, then the `weed`
# inside it. Either differing refuses the binary; nothing unverified is ever installed.
ensure_weed() {
  local pins arch url tarball_sha weed_sha actual work
  pins="$RELEASE/deploy/object-store/seaweedfs.release"
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) human "$WEED" "no pinned SeaweedFS build for $(uname -m) in deploy/object-store/seaweedfs.release"; return 0 ;;
  esac
  # KEY=value lines only; read, never sourced.
  url="$(env_value "$pins" "SEAWEEDFS_URL_$arch")"
  tarball_sha="$(env_value "$pins" "SEAWEEDFS_TARBALL_SHA256_$arch")"
  weed_sha="$(env_value "$pins" "SEAWEEDFS_WEED_SHA256_$arch")"
  actual="$(p "$WEED")"
  if [ -f "$actual" ] && [ "$(sha256sum "$actual" | cut -d' ' -f1)" = "$weed_sha" ]; then return 0; fi
  if [ "$MODE" = check ]; then
    # Applying fetches it, which needs the network; until then it is listed with what to place.
    human "$WEED" "SeaweedFS $(env_value "$pins" SEAWEEDFS_VERSION) is missing or not the pinned binary: $SELF fetches it from $url (tarball sha256 $tarball_sha, weed sha256 $weed_sha)"
    return 0
  fi
  url="${KF_OBJECTS_RELEASE_URL:-$url}"
  work="$(mktemp -d)"
  if ! curl --silent --show-error --fail --location --proto '=https,file' --max-time 600 \
      --output "$work/seaweedfs.tar.gz" "$url" 2>"$work/error"; then
    human "$WEED" "SeaweedFS could not be fetched from $url ($(head -c 200 "$work/error")); fetch it, check sha256 $tarball_sha, and place its weed (sha256 $weed_sha) here"
    rm -rf -- "$work"
    return 0
  fi
  if [ "$(sha256sum "$work/seaweedfs.tar.gz" | cut -d' ' -f1)" != "$tarball_sha" ]; then
    human "$WEED" "REFUSED: the SeaweedFS tarball from $url is not the pinned one (sha256 $tarball_sha)"
    rm -rf -- "$work"
    return 0
  fi
  if ! tar -xzf "$work/seaweedfs.tar.gz" -C "$work" weed 2>/dev/null ||
     [ "$(sha256sum "$work/weed" | cut -d' ' -f1)" != "$weed_sha" ]; then
    human "$WEED" "REFUSED: the weed in the pinned SeaweedFS tarball is not the pinned binary (sha256 $weed_sha)"
    rm -rf -- "$work"
    return 0
  fi
  mkdir -p -- "$(dirname -- "$actual")"
  chmod 755 "$(dirname -- "$actual")"
  install -m 0755 "$work/weed" "$actual"
  chown root:root "$actual"
  rm -rf -- "$work"
  created "SeaweedFS $(env_value "$pins" SEAWEEDFS_VERSION) at $WEED (sha256 $weed_sha)"
}

# name|env file|secret file|owner|role: each service that may use this host's store, and how.
OBJECT_IDENTITIES=(
  "kf-api|/etc/kf/api.env|/etc/kf/api/s3-secret-access-key|kf-api|app"
  "kf-worker|/etc/kf/worker.env|/etc/kf/worker/s3-secret-access-key|kf-worker|app"
  "kf-storage|/etc/kf/storage/storage.env|/etc/kf/storage/s3-secret|kf-storage|storage"
  "kf-drill|/etc/kf/drill.env|/etc/kf/drill/s3-secret-access-key|kf-drill|readonly"
)

# For every service routed at this host's store: generate its secret (a person would only have to
# invent one), give it the key id its identity is named by, and render the store's identities
# file from those secrets. A service routed at another store is left to its human secret.
ensure_local_objects() {
  local entry name env secret owner role lines bucket output identities
  [ -d "$(p /etc/kf/objects)" ] && [ -d "$(p /etc/kf/objects-init)" ] || return 0
  generate_secret kf-objects-init /etc/kf/objects-init/admin-secret token
  lines="kf-objects-admin|$(p /etc/kf/objects-init/admin-secret)|admin"
  bucket=''
  for entry in "${OBJECT_IDENTITIES[@]}"; do
    IFS='|' read -r name env secret owner role <<< "$entry"
    [ -f "$(p "$env")" ] || continue
    [ "$(env_value "$(p "$env")" S3_ENDPOINT)" = "$LOCAL_OBJECTS" ] || continue
    generate_secret "$owner" "$secret" token
    if [ "$MODE" = apply ]; then set_env_value "$(p "$env")" S3_ACCESS_KEY_ID "$name"; fi
    [ -n "$bucket" ] || bucket="$(env_value "$(p "$env")" S3_BUCKET_ARTIFACTS)"
    lines="$lines"$'\n'"$name|$(p "$secret")|$role"
  done
  [ -n "$bucket" ] || bucket=kf-artifacts
  if [ "$MODE" = apply ]; then
    set_env_value "$(p /etc/kf/objects-init/objects.env)" KF_OBJECTS_BUCKETS "$bucket"
  fi
  identities="$(p /etc/kf/objects/identities.json)"
  if [ "$MODE" = check ]; then
    [ -s "$identities" ] || pending "object-store identities /etc/kf/objects/identities.json"
    return 0
  fi
  # Secrets are read by the renderer from their files; only paths cross this boundary.
  if ! output="$(KF_OBJECTS_IDENTITIES="$lines" "$NODE" \
      "$RELEASE/deploy/object-store/render-identities.mjs" "$identities" "$POLICY_TEMPLATE" \
      "$bucket" 2>&1)"; then
    human /etc/kf/objects/identities.json "could not be rendered: $output"
    return 0
  fi
  chown kf-objects:kf-objects "$identities"
  if [ "$output" = changed ]; then
    created "object-store identities /etc/kf/objects/identities.json"
    # The store reads its identities at start; a running one is restarted to take new ones.
    if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
      systemctl try-restart kf-objects.service || true
    fi
  fi
}

# ---------------------------------------------------------------------------------------------
# This host's own PostgreSQL 18: the database, its logins and their connection strings
# ---------------------------------------------------------------------------------------------

# Every one of these was a "connection string only a person can supply" until the first
# rehearsal of the VPS install (KF-WAR-0001, 2026-10-07). On a host whose cluster is local, root
# can make each login and its password itself, and a person typing eleven passwords into eleven
# files is eleven chances to put the migrator's URL where the API's belongs — the mistake the API
# refuses to start through. The roles each login holds were written nowhere in one place; they
# are here, and `tests/deployment/provision-host.test.ts` holds them.
#
# login|group roles (comma-separated)|url file|owner
DB_LOGINS=(
  "kf_api_login|kf_app|/etc/kf/api/database-url|kf-api"
  "kf_worker_login|kf_worker|/etc/kf/worker/database-url|kf-worker"
  "kf_attestor_login|kf_attestor|/etc/kf/attestor/database-url|kf-attestor"
  "kf_checkpoint_login|kf_checkpoint|/etc/kf/checkpoint/database-url|kf-checkpoint"
  "kf_audit_verify_login|kf_checkpoint|/etc/kf/audit-verify/database-url|kf-audit-verify"
  "kf_backup_login|kf_backup|/etc/kf/backup/database-url|kf-backup"
  "kf_offsite_login|kf_backup|/etc/kf/offsite/database-url|kf-offsite"
  "kf_drill_login|kf_backup|/etc/kf/drill/database-url|kf-drill"
  "kf_readiness_login|kf_app|/etc/kf/readiness/database-url|kf-readiness"
  "kf_storage_login|kf_app,kf_service_actor|/etc/kf/storage/database-url|kf-storage"
  "kf_notify_login|kf_notifier|/etc/kf/notify/database-url|kf-notify"
)
MIGRATOR_LOGIN=kf_migrator_login
REHEARSAL_LOGIN=kf_rehearsal_migrator
REHEARSAL_DATABASE=kf_rehearsal
PG_PLANNER_NAME=kf-planner.conf

DATABASE_LOCAL=0      # 1 when this run provisions the local cluster's logins
DATABASE_URLS_DONE=" " # url files handled here, so the human list does not repeat them

# "<port> <status>" of a Debian postgresql-common cluster ("18/main"), empty when there is none.
cluster_state() {
  local version="${1%%/*}" name="${1#*/}"
  [ -x "$(p /usr/bin/pg_lsclusters)" ] || return 0
  "$(p /usr/bin/pg_lsclusters)" --no-header 2>/dev/null |
    awk -v v="$version" -v n="$name" '$1 == v && $2 == n { print $3, $4; exit }' || true
}

# SQL on stdin, run as the cluster's superuser over its local socket.
as_postgres() {
  local port="$1" database="$2"
  # Notices ("already been granted", "already exists") are every re-run's normal case.
  runuser -u postgres -- env PGOPTIONS='-c client_min_messages=warning' \
    "$(p "$PG_CLIENT")/psql" -X -q -v ON_ERROR_STOP=1 -p "$port" -d "$database"
}
query_postgres() {
  local port="$1" database="$2" sql="$3"
  runuser -u postgres -- "$(p "$PG_CLIENT")/psql" -X -q -A -t -v ON_ERROR_STOP=1 \
    -p "$port" -d "$database" -c "$sql"
}

# The NOLOGIN group roles the release's migrations create, read from the migrations themselves so
# a release that adds one (kf_attestor, kf_service_actor and kf_notifier each arrived that way)
# is provisioned without editing this list.
release_group_roles() {
  grep -ohE 'create role kf_[a-z_]+ nologin' "$RELEASE"/database/migrations/*.sql 2>/dev/null |
    awk '{ print $3 }' | LC_ALL=C sort -u
}

# Group roles, the owning login and the database with its extensions, on one cluster. What the
# migrator needs and why is docs/deployment/dogfood-vm.md "The database, and what installing it
# found": CREATEROLE, the group roles pre-created with ADMIN OPTION, the untrusted extensions
# pre-created, BYPASSRLS for the definer seams (ADR 0026) — and never superuser.
ensure_database_owner() {
  local port="$1" login="$2" database="$3" role
  {
    printf 'do $kf$ begin\n'
    while IFS= read -r role; do
      printf "  if not exists (select from pg_roles where rolname = '%s') then create role %s nologin; end if;\n" "$role" "$role"
    done <<< "$GROUPS_FROM_RELEASE"
    printf "  if not exists (select from pg_roles where rolname = '%s') then create role %s login; end if;\n" "$login" "$login"
    printf 'end $kf$;\n'
    printf 'alter role %s login nosuperuser createrole nocreatedb bypassrls inherit;\n' "$login"
    while IFS= read -r role; do
      printf 'grant %s to %s with admin option;\n' "$role" "$login"
    done <<< "$GROUPS_FROM_RELEASE"
    printf "select format('create database %%I owner %%I', '%s', '%s') where not exists (select from pg_database where datname = '%s') \\\\gexec\n" "$database" "$login" "$database"
  } | as_postgres "$port" postgres
  printf 'create extension if not exists btree_gist;\ncreate extension if not exists pg_trgm;\n' |
    as_postgres "$port" "$database"
}

# One login holding exactly its group roles: anything else it picked up is revoked and its
# attributes re-stated, as apps/api/src/dogfood/logins.ts does for the workstation's logins.
ensure_service_login() {
  local port="$1" login="$2" roles="$3" database="$4" role
  {
    printf "do \$kf\$ begin if not exists (select from pg_roles where rolname = '%s') then create role %s login; end if; end \$kf\$;\n" "$login" "$login"
    printf 'alter role %s login nosuperuser nocreaterole nocreatedb nobypassrls inherit;\n' "$login"
    printf "select format('revoke %%I from %%I granted by %%I', g.rolname, u.rolname, gr.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member join pg_roles gr on gr.oid = m.grantor where u.rolname = '%s' and g.rolname <> all (string_to_array('%s', ',')) \\\\gexec\n" "$login" "$roles"
    for role in ${roles//,/ }; do printf 'grant %s to %s;\n' "$role" "$login"; done
    printf 'grant connect on database %s to %s;\n' "$database" "$login"
    # The job queue creates and migrates its own graphile_worker schema on every start, so the
    # worker alone may create in the database (dogfood-vm.md, "Worker and web").
    case ",$roles," in
      *,kf_worker,*) printf 'grant create, temporary on database %s to %s;\n' "$database" "$login" ;;
      *) printf 'revoke create on database %s from %s;\n' "$database" "$login" ;;
    esac
  } | as_postgres "$port" postgres
}

# A connection string for <login>, written when the file is empty or the login did not exist
# before this run (a recreated cluster), never otherwise: a working file is never re-keyed.
ensure_login_url() {
  local port="$1" login="$2" database="$3" path="$4" owner="$5" existed="$6" actual staged
  actual="$(p "$path")"
  if [ -s "$actual" ] && [ "$existed" = 1 ]; then
    check_secret_posture "$owner" "$path"
    return 0
  fi
  staged="$actual.provisioning"
  rm -f -- "$staged"
  : > "$staged"
  chmod 600 "$staged"
  # The password is made and written inside node; only the SCRAM verifier crosses the pipe.
  "$NODE" "$RELEASE/deploy/postgres/login-url.mjs" "$staged" "$login" "$port" "$database" |
    as_postgres "$port" postgres
  chown "$owner:$owner" "$staged"
  mv -f -- "$staged" "$actual"
  created "$path: login $login on port $port (0600 $owner)"
}

login_exists() {
  [ "$(query_postgres "$1" postgres "select count(*) from pg_roles where rolname = '$2'")" = 1 ] &&
    echo 1 || echo 0
}

ensure_local_database() {
  local env mode cluster database rehearsal state port status entry login roles path owner existed
  local planner conf_dir receipt
  env="$(p /etc/kf/database.env)"
  [ -f "$env" ] || return 0
  mode="$(env_value "$env" KF_DATABASE)"
  case "${mode:-local}" in
    local) ;;
    external) return 0 ;;
    *) human /etc/kf/database.env "KF_DATABASE=$mode is neither local nor external"; return 0 ;;
  esac
  cluster="$(env_value "$env" KF_DATABASE_CLUSTER)"; cluster="${cluster:-18/main}"
  database="$(env_value "$env" KF_DATABASE_NAME)"; database="${database:-kf}"
  rehearsal="$(env_value "$env" KF_REHEARSAL_CLUSTER)"; rehearsal="${rehearsal:-18/rehearsal}"
  PG_CLIENT="$(postgres_client_dir)"
  if [ -z "$PG_CLIENT" ] || [ ! -x "$(p /usr/bin/pg_lsclusters)" ] ||
     [ ! -x "$(p /usr/lib/postgresql/18/bin/postgres)" ]; then
    human "PostgreSQL 18 server" "install it (Debian: postgresql-18 from apt.postgresql.org, which creates cluster 18/main), or set KF_DATABASE=external in /etc/kf/database.env and supply every database-url yourself"
    return 0
  fi
  read -r port status <<< "$(cluster_state "$cluster")" || true
  if [ -z "${port:-}" ] || [ "${status:-}" != online ]; then
    human "PostgreSQL cluster $cluster" "is ${status:-absent}: pg_ctlcluster ${cluster%%/*} ${cluster#*/} start (or create it with pg_createcluster), then re-run $SELF"
    return 0
  fi
  DATABASE_LOCAL=1
  GROUPS_FROM_RELEASE="$(release_group_roles)"
  if [ -z "$GROUPS_FROM_RELEASE" ]; then
    human "$RELEASE/database/migrations" "names no group role; this is not a Knowledge Fabric release"
    return 0
  fi

  # The planner settings readiness checks (jit = off, KF-SAS-RQ-076), in the cluster's conf.d.
  conf_dir="$(p "/etc/postgresql/${cluster%%/*}/${cluster#*/}/conf.d")"
  planner="$conf_dir/$PG_PLANNER_NAME"
  if [ -d "$conf_dir" ] && ! cmp -s "$RELEASE/deploy/postgres/planner.conf" "$planner"; then
    if [ "$MODE" = check ]; then
      pending "/etc/postgresql/$cluster/conf.d/$PG_PLANNER_NAME from deploy/postgres/planner.conf"
    else
      install -m 0644 "$RELEASE/deploy/postgres/planner.conf" "$planner"
      [ -n "$PREFIX" ] || pg_ctlcluster "${cluster%%/*}" "${cluster#*/}" reload
      created "/etc/postgresql/$cluster/conf.d/$PG_PLANNER_NAME (jit = off), cluster reloaded"
    fi
  fi

  local urls=("$MIGRATOR_LOGIN||/etc/kf/migrator/database-url|kf-migrator" "${DB_LOGINS[@]}")
  if [ "$MODE" = check ]; then
    for entry in "${urls[@]}"; do
      IFS='|' read -r login roles path owner <<< "$entry"
      DATABASE_URLS_DONE+="$path "
      [ -s "$(p "$path")" ] || pending "login $login on cluster $cluster and its connection string $path"
    done
  else
    existed="$(login_exists "$port" "$MIGRATOR_LOGIN")"
    ensure_database_owner "$port" "$MIGRATOR_LOGIN" "$database"
    ensure_login_url "$port" "$MIGRATOR_LOGIN" "$database" /etc/kf/migrator/database-url kf-migrator "$existed"
    DATABASE_URLS_DONE+="/etc/kf/migrator/database-url "
    for entry in "${DB_LOGINS[@]}"; do
      IFS='|' read -r login roles path owner <<< "$entry"
      existed="$(login_exists "$port" "$login")"
      ensure_service_login "$port" "$login" "$roles" "$database"
      ensure_login_url "$port" "$login" "$database" "$path" "$owner" "$existed"
      DATABASE_URLS_DONE+="$path "
    done
  fi

  # The rollback rehearsal's DISPOSABLE cluster: its own server, its own credential, empty.
  read -r port status <<< "$(cluster_state "$rehearsal")" || true
  DATABASE_URLS_DONE+="/etc/kf/migrator/rehearsal-database-url "
  # Dropped after a rehearsal, as it must be: once the live release's receipt exists there is
  # nothing left for one to do, so it is neither recreated nor reported missing. The next release
  # names a new receipt path (complete_migrator_env), and that brings a fresh cluster.
  receipt="$(env_value "$(p /etc/kf/migrator.env)" KF_ROLLBACK_REHEARSAL_RECEIPT)"
  if [ -z "${port:-}" ] && [ -n "$receipt" ] && ! is_placeholder "$receipt" && [ -s "$(p "$receipt")" ]; then
    return 0
  fi
  if [ -z "${port:-}" ]; then
    if [ "$MODE" = check ]; then
      pending "disposable rehearsal cluster $rehearsal, login $REHEARSAL_LOGIN and /etc/kf/migrator/rehearsal-database-url"
      return 0
    fi
    pg_createcluster "${rehearsal%%/*}" "${rehearsal#*/}" --start >/dev/null
    created "disposable rehearsal cluster $rehearsal"
    read -r port status <<< "$(cluster_state "$rehearsal")" || true
  elif [ "$status" != online ]; then
    if [ "$MODE" = check ]; then pending "start the rehearsal cluster $rehearsal"; return 0; fi
    pg_ctlcluster "${rehearsal%%/*}" "${rehearsal#*/}" start
  fi
  if [ "$MODE" = check ]; then
    [ -s "$(p /etc/kf/migrator/rehearsal-database-url)" ] ||
      pending "login $REHEARSAL_LOGIN on $rehearsal and /etc/kf/migrator/rehearsal-database-url"
    return 0
  fi
  existed="$(login_exists "$port" "$REHEARSAL_LOGIN")"
  ensure_database_owner "$port" "$REHEARSAL_LOGIN" "$REHEARSAL_DATABASE"
  ensure_login_url "$port" "$REHEARSAL_LOGIN" "$REHEARSAL_DATABASE" \
    /etc/kf/migrator/rehearsal-database-url kf-migrator "$existed"
}

# A database-url a person supplies only when this run did not make it.
database_url_secret() {
  case "$DATABASE_URLS_DONE" in *" $2 "*) return 0 ;; esac
  ensure_human_secret "$@"
}

# ---------------------------------------------------------------------------------------------
# How people reach the host: the tailnet, its certificate and nginx (ADR 0039)
# ---------------------------------------------------------------------------------------------

NGINX_TEMPLATE="$RELEASE/deploy/nginx/knowledge-fabric-tailnet.conf"
NGINX_SITE=/etc/nginx/sites-available/knowledge-fabric.conf
NGINX_WAIT_TEMPLATE="$RELEASE/deploy/nginx/nginx-waits-for-tailnet.conf"
NGINX_WAIT_DROPIN=/etc/systemd/system/nginx.service.d/kf-tailnet-address.conf

# The tailnet's view of this host, as `tailscale status --json` reports it: state, DNS name
# without its trailing dot, first IPv4 address. Tab-separated; empty when tailscale cannot say.
tailnet_self() {
  "$(p /usr/bin/tailscale)" status --json 2>/dev/null | "$NODE" -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      try {
        const status = JSON.parse(text);
        const self = status.Self ?? {};
        const v4 = (self.TailscaleIPs ?? []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? "";
        process.stdout.write([status.BackendState ?? "", (self.DNSName ?? "").replace(/\.$/, ""), v4].join("\t"));
      } catch { process.stdout.write("unreadable\t\t"); }
    });' || true
}

render_nginx_site() {
  sed -e "s/KF_TAILNET_ADDRESS/$2/g" -e "s/KF_TAILNET_HOSTNAME/$1/g" "$NGINX_TEMPLATE"
}

ensure_tailnet() {
  local env access hostname address state seen_name seen_address rendered target enabled
  env="$(p /etc/kf/tailnet.env)"
  [ -f "$env" ] || return 0
  access="$(env_value "$env" KF_HOST_ACCESS)"
  case "${access:-tailnet}" in
    tailnet) ;;
    private-ca) return 0 ;;
    *) human /etc/kf/tailnet.env "KF_HOST_ACCESS=$access is neither tailnet nor private-ca"; return 0 ;;
  esac

  # Host requirements this access model adds (SAS §85).
  if [ ! -x "$(p /usr/bin/tailscale)" ]; then
    human "tailscale (/usr/bin/tailscale)" "install it from pkgs.tailscale.com, then \`sudo tailscale up\` to join this host to the tailnet"
  fi
  if [ ! -x "$(p /usr/sbin/nginx)" ]; then
    human "nginx (/usr/sbin/nginx)" "install it (Debian: apt install nginx-light); it terminates TLS on the tailnet address"
  fi

  hostname="$(env_value "$env" KF_TAILNET_HOSTNAME)"
  address="$(env_value "$env" KF_TAILNET_ADDRESS)"
  if [ -x "$(p /usr/bin/tailscale)" ]; then
    IFS=$'\t' read -r state seen_name seen_address <<< "$(tailnet_self)" || true
    if [ "${state:-}" != Running ]; then
      human "tailscale status" "this host is not up on the tailnet (state: ${state:-unknown}); run \`sudo tailscale up\` and approve it in the tailnet's admin console"
    else
      # Filled from what tailscale reports, never over a value somebody set. A value that
      # disagrees with it is reported, because the certificate is issued for the name tailscale
      # knows and nginx can only listen on the address tailscale assigned.
      for pair in "KF_TAILNET_HOSTNAME:$seen_name" "KF_TAILNET_ADDRESS:$seen_address"; do
        local name="${pair%%:*}" seen="${pair#*:}" current
        current="$(env_value "$env" "$name")"
        [ -n "$seen" ] || continue
        if [ -z "$current" ]; then
          if [ "$MODE" = check ]; then pending "/etc/kf/tailnet.env: $name=$seen, from tailscale status"
          else set_env_value "$env" "$name" "$seen"; fi
        elif [ "$current" != "$seen" ]; then
          human /etc/kf/tailnet.env "$name=$current, but tailscale reports $seen for this host"
        fi
      done
      # In --check, what would be filled counts as filled.
      hostname="$(env_value "$env" KF_TAILNET_HOSTNAME)"
      address="$(env_value "$env" KF_TAILNET_ADDRESS)"
      hostname="${hostname:-$seen_name}"
      address="${address:-$seen_address}"
    fi
  fi
  if [[ ! "$hostname" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$ ]]; then
    human /etc/kf/tailnet.env "KF_TAILNET_HOSTNAME: this host's tailnet name, <host>.<tailnet>.ts.net (tailscale status --json: Self.DNSName)"
    hostname=""
  fi
  if [[ ! "$address" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    human /etc/kf/tailnet.env "KF_TAILNET_ADDRESS: this host's tailnet IPv4 address (tailscale ip -4)"
    address=""
  fi

  # The public origins every other file names, from the one name the tailnet gave this host. A
  # tailnet name has no subdomains, so the API is the same name on 8443, as the nginx template
  # serves it. Each was a line a person typed (private-host.md, "First host" step 3).
  if [ -n "$hostname" ]; then
    fill_env_value /etc/kf/api.env KF_WEB_ORIGIN "https://$hostname"
    fill_env_value /etc/kf/api.env KF_API_ORIGIN "https://$hostname:8443"
    fill_env_value /etc/kf/web.env KF_WEB_OIDC_REDIRECT_URI "https://$hostname/auth/callback"
    fill_env_value /etc/kf/notify.env KF_NOTIFY_WEB_ORIGIN "https://$hostname"
  fi

  # The certificate is fetched by kf-tls-renew as kf-tls, which tailscaled permits only when told.
  if ! grep -qE '^TS_PERMIT_CERT_UID="?kf-tls"?$' "$(p /etc/default/tailscaled)" 2>/dev/null; then
    human /etc/default/tailscaled "TS_PERMIT_CERT_UID=kf-tls, then systemctl restart tailscaled: lets kf-tls-renew.service fetch the certificate without operator rights"
  fi
  if [ ! -s "$(p /etc/kf/tls/tailnet.crt)" ]; then
    human /etc/kf/tls/tailnet.crt "the tailnet certificate: once the above is done, systemctl enable --now kf-tls-renew.timer && systemctl start kf-tls-renew.service (enable HTTPS certificates in the tailnet's DNS settings first)"
  fi

  # nginx's site, rendered from this release's template for this host. Replaced only when the
  # rendering differs, which is how a release that changes the template reaches the host.
  [ -n "$hostname" ] && [ -n "$address" ] && [ -d "$(p /etc/nginx/sites-available)" ] || return 0
  rendered="$(render_nginx_site "$hostname" "$address")"
  target="$(p "$NGINX_SITE")"
  if [ ! -f "$target" ] || [ "$(cat "$target")" != "$rendered" ]; then
    if [ "$MODE" = check ]; then
      pending "$NGINX_SITE rendered for $hostname on $address"
    else
      printf '%s\n' "$rendered" > "$target"
      chmod 644 "$target"
      created "$NGINX_SITE for $hostname on $address"
    fi
  fi
  # nginx waits at boot for the address it listens on (deploy/nginx/nginx-waits-for-tailnet.conf):
  # without it, it lost the race with tailscaled and the host served nothing after a reboot.
  rendered="$(sed "s/KF_TAILNET_ADDRESS/$address/g" "$NGINX_WAIT_TEMPLATE")"
  target="$(p "$NGINX_WAIT_DROPIN")"
  if [ ! -f "$target" ] || [ "$(cat "$target")" != "$rendered" ]; then
    if [ "$MODE" = check ]; then
      pending "$NGINX_WAIT_DROPIN (nginx waits for $address at boot)"
    else
      install -d -m 0755 -- "$(dirname -- "$target")"
      printf '%s\n' "$rendered" > "$target"
      chmod 644 "$target"
      [ -n "$PREFIX" ] || ! command -v systemctl >/dev/null 2>&1 || systemctl daemon-reload
      created "$NGINX_WAIT_DROPIN for $address"
    fi
  fi
  enabled="$(p /etc/nginx/sites-enabled)/knowledge-fabric.conf"
  if [ -d "$(p /etc/nginx/sites-enabled)" ] && [ ! -L "$enabled" ]; then
    if [ "$MODE" = check ]; then pending "/etc/nginx/sites-enabled/knowledge-fabric.conf -> $NGINX_SITE"
    else ln -s "$NGINX_SITE" "$enabled"; created "/etc/nginx/sites-enabled/knowledge-fabric.conf"; fi
  fi
  # Debian's own default site listens on every interface. It is not removed here — it is the
  # distribution's file — but nothing is commissioned while it is enabled.
  if [ -e "$(p /etc/nginx/sites-enabled/default)" ]; then
    human /etc/nginx/sites-enabled/default "remove it, then RESTART nginx (rm /etc/nginx/sites-enabled/default && systemctl restart nginx): Debian's default site listens on 0.0.0.0:80, the public interface, and a reload keeps that socket open (measured 2026-10-07)"
  fi
}

# ---------------------------------------------------------------------------------------------
# Units
# ---------------------------------------------------------------------------------------------

install_units() {
  local unit target changed=0
  if [ "$MODE" = apply ] && [ ! -d "$(p /etc/systemd/system)" ]; then
    mkdir -p -- "$(p /etc/systemd/system)"
    chmod 755 "$(p /etc/systemd/system)"
  fi
  for unit in "$TEMPLATES"/*.service "$TEMPLATES"/*.timer "$TEMPLATES"/*.socket "$TEMPLATES"/*.path; do
    [ -f "$unit" ] || continue
    target="$(p /etc/systemd/system)/$(basename -- "$unit")"
    if [ -f "$target" ] && cmp -s "$unit" "$target"; then continue; fi
    if [ "$MODE" = check ]; then pending "unit $(basename -- "$unit") (missing or differs from this release)"; continue; fi
    cat "$unit" > "$target"
    chmod 644 "$target"
    changed=1
    created "unit $(basename -- "$unit")"
  done
  if [ "$changed" = 1 ] && [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
  fi
}

# ---------------------------------------------------------------------------------------------
# An operator-supplied object-store verifier that was never supplied
# ---------------------------------------------------------------------------------------------

check_verifier_override() {
  local env program digest
  env="$(p /etc/kf/backup.env)"
  program="$(env_value "$env" KF_OBJECT_STORE_VERIFY_PROGRAM)"
  [ -n "$program" ] || return 0
  digest="$(env_value "$env" KF_OBJECT_STORE_VERIFY_PROGRAM_SHA256)"
  if [ ! -x "$(p "$program")" ] || is_placeholder "$digest" || [ -z "$digest" ]; then
    human /etc/kf/backup.env "KF_OBJECT_STORE_VERIFY_PROGRAM names $program, which is absent or unpinned: comment both KF_OBJECT_STORE_VERIFY_PROGRAM lines out to use the verifier the release ships, or install and pin it"
  fi
}

# ---------------------------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------------------------

for user in "${USERS[@]}"; do ensure_user "$user"; done
ensure_archive_group
ensure_attest_group
ensure_retrieval_group

for entry in "${DIRECTORIES[@]}"; do
  read -r mode owner group path <<< "$entry"
  ensure_dir "$mode" "$owner" "$group" "$path"
done

for entry in "${ENV_FILES[@]}"; do
  read -r template path mode owner group <<< "$entry"
  ensure_env_file "$template" "$path" "$mode" "$owner" "$group"
done
# Units first: a later step restarts kf-objects when its identities change, and on a first run
# that unit did not exist yet ("Unit kf-objects.service not found", 2026-10-07 rehearsal).
install_units

if [ -d "$(p /etc/kf/migrator)" ]; then
  generate_secret kf-migrator /etc/kf/migrator/rehearsal-receipt-key raw32
  generate_secret kf-web /etc/kf/web/session-key base64-32
  generate_secret kf-api /etc/kf/api/readiness-token token
  generate_secret kf-api /etc/kf/api/master-record-link-secret token
  if [ "$MODE" = apply ]; then
    set_env_value "$(p /etc/kf/api.env)" KF_READINESS_TOKEN_FILE /etc/kf/api/readiness-token
    set_env_value "$(p /etc/kf/api.env)" KF_MASTER_RECORD_LINK_SECRET_FILE /etc/kf/api/master-record-link-secret
  fi
  ensure_checkpoint_key
  complete_env_files
  # Before the human secrets below: a service routed at this host's own store gets a generated
  # secret, so its placeholder is never created empty.
  ensure_weed
  ensure_local_objects
  complete_migrator_env
  ensure_local_database
  copy_alert_webhook_for_notify

  database_url_secret kf-api /etc/kf/api/database-url "connection string for the API's login (a member of kf_app; never the migrator's)"
  ensure_human_secret kf-api /etc/kf/api/s3-secret-access-key "secret for S3_ACCESS_KEY_ID in /etc/kf/api.env"
  database_url_secret kf-worker /etc/kf/worker/database-url "connection string for the worker's login"
  ensure_human_secret kf-worker /etc/kf/worker/s3-secret-access-key "secret for S3_ACCESS_KEY_ID in /etc/kf/worker.env"
  database_url_secret kf-migrator /etc/kf/migrator/database-url "connection string for the migrator login (inherits kf_migrator)"
  database_url_secret kf-migrator /etc/kf/migrator/rehearsal-database-url "connection string for a DISPOSABLE, empty PostgreSQL 18 cluster used only by the rollback rehearsal"
  database_url_secret kf-checkpoint /etc/kf/checkpoint/database-url "connection string for the checkpoint signer's login (kf_checkpoint)"
  ensure_human_secret kf-checkpoint /etc/kf/checkpoint/anchor-secret-access-key "secret for CHECKPOINT_S3_ACCESS_KEY_ID: a write-only key on the anchor bucket, held by nobody who administers the database"
  database_url_secret kf-backup /etc/kf/backup/database-url "connection string for the backup login (kf_backup)"
  ensure_human_secret kf-backup /etc/kf/backup/preservation-manifest-key "the preservation Ed25519 PRIVATE key from its external custody; install its public half as /etc/kf/preservation-trust.d/<id>.pub and set PRESERVATION_SIGNING_KEY_ID=<id> in /etc/kf/backup.env"
  database_url_secret kf-offsite /etc/kf/offsite/database-url "connection string for the off-site copier's login"
  database_url_secret kf-readiness /etc/kf/readiness/database-url "connection string for the readiness login (read-only)"
  database_url_secret kf-storage /etc/kf/storage/database-url "connection string for the storage sweep's login (member of kf_app AND kf_service_actor)"
  database_url_secret kf-attestor /etc/kf/attestor/database-url "connection string for the attestor's login (member of kf_attestor ONLY; the API's login must never be)"
  ensure_human_secret kf-storage /etc/kf/storage/s3-secret "secret for S3_ACCESS_KEY_ID in /etc/kf/storage/storage.env (the working store)"
  ensure_human_secret kf-storage /etc/kf/storage/s3-durable-secret "secret for S3_DURABLE_ACCESS_KEY_ID in /etc/kf/storage/storage.env"
  database_url_secret kf-audit-verify /etc/kf/audit-verify/database-url "connection string for the audit verifier's login (member of kf_checkpoint for its cross-organization reads)"
  ensure_human_secret kf-alert /etc/kf/alert/webhook-url "the https:// webhook that reaches a person"
  database_url_secret kf-notify /etc/kf/notify/database-url "connection string for the notifier's login (member of kf_notifier ONLY: it reads no table)"
  ensure_human_secret kf-notify /etc/kf/notify/smtp.json "the digest's SMTP relay: {\"host\", \"port\", \"security\": \"tls\"|\"starttls\", \"user\"?, \"from\"}"
  ensure_human_secret kf-notify /etc/kf/notify/alert-webhook-url "the same https:// endpoint as /etc/kf/alert/webhook-url: the urgent push travels the alert path"
  database_url_secret kf-drill /etc/kf/drill/database-url "connection string the restore drill records into (the production ledger; kf_backup's grants)"
  ensure_human_secret kf-drill /etc/kf/drill/s3-secret-access-key "secret for S3_ACCESS_KEY_ID in /etc/kf/drill.env (a READ-ONLY key on the artifacts bucket)"
fi

if [ -d "$(p /etc/kf/credstore.encrypted)" ]; then ensure_recovery_key; fi
if [ -d "$(p /etc/kf/preservation-trust.d)" ] &&
   [ -z "$(find "$(p /etc/kf/preservation-trust.d)" -maxdepth 1 -name '*.pub' -print -quit)" ]; then
  human /etc/kf/preservation-trust.d/ "the preservation PUBLIC key as <key-id>.pub (append-only; never remove an old one)"
fi
ensure_tailnet
ensure_public_sockets_closed
# Semantic search on the host's CPU is ADR 0039 decision 5, and nothing here installs it: the LAMU
# engine, its offline Python runtime and the bge-m3 model are separate pinned artifacts, and the
# index key arrives by workstation custody. Until 2026-10-07 --check said nothing about it, and a
# host without it read as complete while kf-commissioning's secret_posture could not inspect the
# engine units' key (KF-WAR-0001 rehearsal).
if [ ! -f "$(p /etc/kf/retrieval-runtime.json)" ]; then
  human /etc/kf/retrieval-runtime.json "semantic search is not installed, and this script does not install it: the pinned LAMU engine, its Python runtime and the bge-m3 model per docs/deployment/retrieval-startup.md, and the index key by workstation custody (docs/deployment/retrieval-key-release.md)"
fi
check_liminal_declaration
ensure_rsync_identities
report_env_placeholders
check_verifier_override
POLICY_TO_PRINT=""
if [ -f "$(p /etc/kf/storage/storage.env)" ]; then ensure_storage_policy; fi

# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------

if [ "${#CREATED[@]}" -gt 0 ]; then
  echo "== created"
  printf '  %s\n' "${CREATED[@]}"
fi
if [ "${#PENDING[@]}" -gt 0 ]; then
  echo "== missing, and $SELF creates it"
  printf '  %s\n' "${PENDING[@]}"
fi
if [ -n "$POLICY_TO_PRINT" ]; then
  IFS='|' read -r bucket key <<< "$POLICY_TO_PRINT"
  echo "== object-store policy $POLICY_NAME for key $key (apply with admin rights on the store)"
  render_policy "$bucket" | sed 's/^/  /'
  echo "  (this host's own kf-objects store is granted it automatically; this store is not that one)"
fi
if [ "${#HUMAN[@]}" -gt 0 ]; then
  echo "== inputs only a person can supply"
  printf '%s\n' "${HUMAN[@]}" | awk -F"$US" '
    $1 != last { printf "  %s\n", $1; last = $1 }
    { printf "      %s\n", $2 }'
fi
if [ "${#PENDING[@]}" -eq 0 ] && [ "${#HUMAN[@]}" -eq 0 ]; then
  echo "== nothing missing"
fi

if [ "$MODE" = check ]; then
  [ "${#PENDING[@]}" -eq 0 ] && [ "${#HUMAN[@]}" -eq 0 ]
fi
