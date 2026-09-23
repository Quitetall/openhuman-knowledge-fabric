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
#   KF_MC_ALIAS         an `mc` alias with admin rights on the object store; when set and `mc`
#                       is installed, the orphan-collection policy is applied, not just printed

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
SELF=/opt/kf/scripts/deploy/provision-host.sh

if [ "$MODE" = apply ] && [ -z "$PREFIX" ] && [ "$(id -u)" -ne 0 ]; then
  echo "provision-host: run as root (sudo); --check runs as anyone" >&2
  exit 1
fi

# Host path -> the path acted on (identical on a real host).
p() { printf '%s%s' "$PREFIX" "$1"; }

CREATED=()   # what this run made
PENDING=()   # machine-doable, not done (check mode)
HUMAN=()     # "path|what a person must supply"

created() { CREATED+=("$1"); }
pending() { PENDING+=("$1"); }
human() { HUMAN+=("$1|$2"); }

# ---------------------------------------------------------------------------------------------
# Identities
# ---------------------------------------------------------------------------------------------

USERS=(kf-api kf-web kf-worker kf-migrator kf-checkpoint kf-backup kf-offsite kf-readiness
  kf-storage kf-audit-verify kf-alert kf-drill)

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
  "0750 root kf-drill /etc/kf/drill"
  "0700 root root /etc/kf/credstore.encrypted"
  "0755 root root /etc/kf/preservation-trust.d"
  "0755 root root /etc/kf/checkpoint-public-keys"
  "0700 kf-worker kf-worker /var/lib/kf-worker"
  "0700 kf-migrator kf-migrator /var/lib/kf-migrator"
  "2750 kf-backup kf-archive /srv/kf-backups"
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
  [[ "$1" =~ replace-with|replace-me|\.example\.internal|\.example\.invalid ]]
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
  "storage.env.example /etc/kf/storage/storage.env 0600 kf-storage kf-storage"
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
  value="$(env_value "$(p "$dest")" S3_ENDPOINT)"
  [ -z "$value" ] || is_placeholder "$value" || return 0
  if [ "$MODE" = check ]; then pending "$dest: S3 routing, copied from /etc/kf/api.env"; return 0; fi
  for name in S3_ENDPOINT S3_REGION S3_BUCKET_ARTIFACTS S3_FORCE_PATH_STYLE; do
    value="$(env_value "$source" "$name")"
    [ -z "$value" ] || set_env_value "$(p "$dest")" "$name" "$value" force
  done
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
}

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
      if is_placeholder "$value"; then
        human "$path" "$key (still the template's placeholder: $value)"
      elif [ -z "$value" ] && [[ "$REQUIRED_NONEMPTY" == *" $key "* ]]; then
        human "$path" "$key (empty; the unit refuses or fails without it)"
      fi
    done < "$actual"
  done
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
      const { existsSync, readFileSync, writeFileSync } = require("node:fs");
      const [keyPath, pubdir, configured, write] = process.argv.slice(1);
      const publicKey = createPublicKey(createPrivateKey(readFileSync(keyPath)));
      if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
      const id = configured || "ckpt-" + createHash("sha256")
        .update(publicKey.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16);
      const pub = `${pubdir}/${id}.pub`;
      if (!existsSync(pub)) {
        if (write !== "1") { process.stdout.write(`missing:${id}`); process.exit(0); }
        writeFileSync(pub, publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644 });
        process.stdout.write(`published:${id}`);
        process.exit(0);
      }
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
  local env bucket key policy_file output applied=0
  env="$(p /etc/kf/storage/storage.env)"
  bucket="$(env_value "$env" S3_BUCKET_ARTIFACTS)"
  key="$(env_value "$env" S3_ACCESS_KEY_ID)"
  if [ -z "$bucket" ] || is_placeholder "$bucket"; then bucket='<artifacts bucket>'; fi
  if [ -z "$key" ] || is_placeholder "$key"; then key='<S3_ACCESS_KEY_ID in /etc/kf/storage/storage.env>'; fi
  if [ "$MODE" = apply ] && storage_ready && [ -n "${KF_MC_ALIAS:-}" ] &&
     command -v mc >/dev/null 2>&1; then
    policy_file="$(mktemp)"
    render_policy "$bucket" > "$policy_file"
    mc admin policy create "$KF_MC_ALIAS" "$POLICY_NAME" "$policy_file" >/dev/null
    if ! output="$(mc admin policy attach "$KF_MC_ALIAS" "$POLICY_NAME" --user "$key" 2>&1)"; then
      case "$output" in
        *already*) ;;
        *) rm -f -- "$policy_file"; echo "$output" >&2; exit 1 ;;
      esac
    fi
    rm -f -- "$policy_file"
    applied=1
    created "object-store policy $POLICY_NAME attached to $key (bucket $bucket)"
  fi
  if [ "$MODE" = apply ] && [ "$applied" = 0 ]; then POLICY_TO_PRINT="$bucket|$key"; fi
  # Whether it was applied here or by hand, ask the store — as kf-storage, with its own files.
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
  if [ -z "${KF_MC_ALIAS:-}" ] || ! command -v mc >/dev/null 2>&1; then
    POLICY_TO_PRINT="$bucket|$key"
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
  for unit in "$TEMPLATES"/*.service "$TEMPLATES"/*.timer; do
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

for entry in "${DIRECTORIES[@]}"; do
  read -r mode owner group path <<< "$entry"
  ensure_dir "$mode" "$owner" "$group" "$path"
done

for entry in "${ENV_FILES[@]}"; do
  read -r template path mode owner group <<< "$entry"
  ensure_env_file "$template" "$path" "$mode" "$owner" "$group"
done

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

  ensure_human_secret kf-api /etc/kf/api/database-url "connection string for the API's login (a member of kf_app; never the migrator's)"
  ensure_human_secret kf-api /etc/kf/api/s3-secret-access-key "secret for S3_ACCESS_KEY_ID in /etc/kf/api.env"
  ensure_human_secret kf-worker /etc/kf/worker/database-url "connection string for the worker's login"
  ensure_human_secret kf-worker /etc/kf/worker/s3-secret-access-key "secret for S3_ACCESS_KEY_ID in /etc/kf/worker.env"
  ensure_human_secret kf-migrator /etc/kf/migrator/database-url "connection string for the migrator login (inherits kf_migrator)"
  ensure_human_secret kf-migrator /etc/kf/migrator/rehearsal-database-url "connection string for a DISPOSABLE, empty PostgreSQL 18 cluster used only by the rollback rehearsal"
  ensure_human_secret kf-checkpoint /etc/kf/checkpoint/database-url "connection string for the checkpoint signer's login (kf_checkpoint)"
  ensure_human_secret kf-checkpoint /etc/kf/checkpoint/anchor-secret-access-key "secret for CHECKPOINT_S3_ACCESS_KEY_ID: a write-only key on the anchor bucket, held by nobody who administers the database"
  ensure_human_secret kf-backup /etc/kf/backup/database-url "connection string for the backup login (kf_backup)"
  ensure_human_secret kf-backup /etc/kf/backup/preservation-manifest-key "the preservation Ed25519 PRIVATE key from its external custody; install its public half as /etc/kf/preservation-trust.d/<id>.pub and set PRESERVATION_SIGNING_KEY_ID=<id> in /etc/kf/backup.env"
  ensure_human_secret kf-offsite /etc/kf/offsite/database-url "connection string for the off-site copier's login"
  ensure_human_secret kf-readiness /etc/kf/readiness/database-url "connection string for the readiness login (read-only)"
  ensure_human_secret kf-storage /etc/kf/storage/database-url "connection string for the storage sweep's login"
  ensure_human_secret kf-storage /etc/kf/storage/s3-secret "secret for S3_ACCESS_KEY_ID in /etc/kf/storage/storage.env (the working store)"
  ensure_human_secret kf-storage /etc/kf/storage/s3-durable-secret "secret for S3_DURABLE_ACCESS_KEY_ID in /etc/kf/storage/storage.env"
  ensure_human_secret kf-audit-verify /etc/kf/audit-verify/database-url "connection string for the audit verifier's login (member of kf_checkpoint for its cross-organization reads)"
  ensure_human_secret kf-alert /etc/kf/alert/webhook-url "the https:// webhook that reaches a person"
  ensure_human_secret kf-drill /etc/kf/drill/database-url "connection string the restore drill records into (the production ledger; kf_backup's grants)"
  ensure_human_secret kf-drill /etc/kf/drill/s3-secret-access-key "secret for S3_ACCESS_KEY_ID in /etc/kf/drill.env (a READ-ONLY key on the artifacts bucket)"
fi

if [ -d "$(p /etc/kf/credstore.encrypted)" ]; then ensure_recovery_key; fi
if [ -d "$(p /etc/kf/preservation-trust.d)" ] &&
   [ -z "$(find "$(p /etc/kf/preservation-trust.d)" -maxdepth 1 -name '*.pub' -print -quit)" ]; then
  human /etc/kf/preservation-trust.d/ "the preservation PUBLIC key as <key-id>.pub (append-only; never remove an old one)"
fi
install_units
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
  echo "  with MinIO's client:"
  echo "    mc admin policy create <alias> $POLICY_NAME <the JSON above in a file>"
  echo "    mc admin policy attach <alias> $POLICY_NAME --user $key"
  echo "  or set KF_MC_ALIAS=<alias> and re-run $SELF"
fi
if [ "${#HUMAN[@]}" -gt 0 ]; then
  echo "== inputs only a person can supply"
  printf '%s\n' "${HUMAN[@]}" | awk -F'|' '
    $1 != last { printf "  %s\n", $1; last = $1 }
    { printf "      %s\n", $2 }'
fi
if [ "${#PENDING[@]}" -eq 0 ] && [ "${#HUMAN[@]}" -eq 0 ]; then
  echo "== nothing missing"
fi

if [ "$MODE" = check ]; then
  [ "${#PENDING[@]}" -eq 0 ] && [ "${#HUMAN[@]}" -eq 0 ]
fi
