#!/usr/bin/env bash
# Selected workstation-custody binding; the preservation scripts keep their contracts.
set -euo pipefail
set +x
set +v
ulimit -c 0
umask 077
export PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C

if [ "$#" -ne 1 ] || [[ "$1" != backup && "$1" != offsite && "$1" != drill ]]; then
  echo 'usage: preservation-consumer.sh backup|offsite|drill' >&2
  exit 64
fi
role="$1"
if [ "$EUID" -eq 0 ] || [ "${KF_SECRET_CUSTODY:-}" != systemd ] ||
   [ -z "${CREDENTIALS_DIRECTORY:-}" ] || [ -z "${RUNTIME_DIRECTORY:-}" ]; then
  echo 'native preservation binding requires PID 1 custody' >&2
  exit 1
fi
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"

protected_path() {
  local path="$1" mode
  [ "$(readlink -e -- "$path")" = "$path" ] && [ ! -L "$path" ] || return 1
  while :; do
    [ "$(stat -c '%u' "$path")" = 0 ] || return 1
    mode="$(stat -c '%a' "$path")"
    [ $((8#$mode & 8#7022)) -eq 0 ] || return 1
    [ "$path" != / ] || break
    path="$(dirname -- "$path")"
  done
}
require_public() {
  protected_path "$1" || { echo 'preservation public routing is not root-protected' >&2; exit 1; }
}
for file in "$ROOT/scripts/deploy/preservation-consumer.sh" "$ROOT/scripts/lib/secret.sh"; do
  [ -f "$file" ] && [ "$(stat -c '%h' "$file")" = 1 ] || exit 1
  require_public "$file"
done

# PID 1 creates this directory. EnvironmentFile's old TMPDIR, password file and
# inline values cannot select the scratch filesystem or the downstream routes.
export TMPDIR="$RUNTIME_DIRECTORY"
unset PGPASSFILE KF_PGPASS_OWNED DATABASE_URL
# Source arms an owned empty password file; retain this parent until the child
# exits so the existing EXIT dispatcher removes it. Do not exec away that trap.
. "$ROOT/scripts/lib/secret.sh"
kf_validate_private_tmpfs
helper="$(kf_credential_helper)" || { echo 'preservation custody helper is unavailable' >&2; exit 1; }

fields=(database-url)
case "$role" in
  backup) fields+=(preservation-signing-key); script=backup.sh ;;
  offsite) fields+=(b2-endpoint b2-bucket b2-key-id b2-key); script=backup-offsite.sh ;;
  drill) fields+=(backup-decryption-key s3-secret-access-key b2-endpoint b2-bucket b2-key-id b2-key); script=restore-drill.sh ;;
esac
[ "$(readlink -e -- "$CREDENTIALS_DIRECTORY")" = "$CREDENTIALS_DIRECTORY" ] || exit 1
expected="$(printf '%s\n' "${fields[@]}" | sort)"
actual="$(find "$CREDENTIALS_DIRECTORY" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)"
if [ "$actual" != "$expected" ]; then
  echo 'preservation credential set mismatch' >&2
  exit 1
fi
for name in "${fields[@]}"; do
  env -i PATH=/usr/bin:/bin LANG=C.UTF-8 "$helper" "$CREDENTIALS_DIRECTORY" "$name"
done
[ -f "$ROOT/scripts/$script" ] && [ "$(stat -c '%h' "$ROOT/scripts/$script")" = 1 ] || exit 1
require_public "$ROOT/scripts/$script"
[ -d "${PRESERVATION_TRUST_STORE_DIR:-}" ] || { echo 'preservation trust store is required' >&2; exit 1; }
require_public "$PRESERVATION_TRUST_STORE_DIR"
require_public "${KF_POSTGRES_CLIENT_DIR:-/usr/bin}"

consumer_env=(PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C KF_SECRET_CUSTODY=systemd
  "CREDENTIALS_DIRECTORY=$CREDENTIALS_DIRECTORY" "TMPDIR=$TMPDIR"
  "DATABASE_URL_FILE=$CREDENTIALS_DIRECTORY/database-url"
  "PRESERVATION_TRUST_STORE_DIR=$PRESERVATION_TRUST_STORE_DIR"
  "KF_POSTGRES_CLIENT_DIR=${KF_POSTGRES_CLIENT_DIR:-/usr/bin}")
case "$role" in
  backup)
    [ -n "${PRESERVATION_SIGNING_KEY_ID:-}" ] && [ -d "${CHECKPOINT_PUBLIC_KEY_DIR:-}" ] &&
      [ -s "${KF_BACKUP_RECIPIENT_FILE:-}" ] || { echo 'backup public keys and signer identity are required' >&2; exit 1; }
    require_public "$CHECKPOINT_PUBLIC_KEY_DIR"
    require_public "$KF_BACKUP_RECIPIENT_FILE"
    consumer_env+=(KF_DEPLOYMENT_PROFILE=dogfood
      "PRESERVATION_SIGNING_KEY_PATH=$CREDENTIALS_DIRECTORY/preservation-signing-key"
      "PRESERVATION_SIGNING_KEY_ID=$PRESERVATION_SIGNING_KEY_ID"
      "CHECKPOINT_PUBLIC_KEY_DIR=$CHECKPOINT_PUBLIC_KEY_DIR"
      "KF_BACKUP_RECIPIENT_FILE=$KF_BACKUP_RECIPIENT_FILE"
      "KF_BACKUP_RETAIN_LOCAL=${KF_BACKUP_RETAIN_LOCAL:-7}"
      "KF_BACKUP_FREE_SPACE_RESERVE_BYTES=${KF_BACKUP_FREE_SPACE_RESERVE_BYTES:-1073741824}")
    args=("/srv/kf-backups/$(date -u +%Y%m%dT%H%M%SZ)")
    ;;
  offsite|drill)
    consumer_env+=("KF_B2_S3_ENDPOINT_FILE=$CREDENTIALS_DIRECTORY/b2-endpoint"
      "KF_B2_BUCKET_NAME_FILE=$CREDENTIALS_DIRECTORY/b2-bucket"
      "KF_B2_APPLICATION_KEY_ID_FILE=$CREDENTIALS_DIRECTORY/b2-key-id"
      "KF_B2_APPLICATION_KEY_FILE=$CREDENTIALS_DIRECTORY/b2-key")
    if [ "$role" = offsite ]; then
      [ "${KF_OFFSITE_DESTINATION:-}" = b2 ] && [ -n "${KF_OFFSITE_LABEL:-}" ] || {
        echo 'selected offsite binding requires B2 and a label' >&2; exit 1;
      }
      shopt -s nullglob
      backups=(/srv/kf-backups/*/)
      [ "${#backups[@]}" -gt 0 ] || { echo 'no local backup exists for copying' >&2; exit 1; }
      newest="${backups[-1]%/}"
      [ ! -L "$newest" ] && [ "$(readlink -e -- "$newest")" = "$newest" ] || exit 1
      args=("$newest" b2 "$KF_OFFSITE_LABEL")
      if [ -n "${KF_OFFSITE_FAILURE_DOMAIN:-}" ]; then args+=(--separate-domain "$KF_OFFSITE_FAILURE_DOMAIN"); fi
    else
      [ "${KF_DRILL_OFFSITE_SOURCE:-}" = b2 ] && [ -n "${KF_DRILL_OFFSITE_LABEL:-}" ] &&
        [ -d "${CHECKPOINT_PUBLIC_KEY_DIR:-}" ] || { echo 'selected drill binding requires B2, label and checkpoint keys' >&2; exit 1; }
      require_public "$CHECKPOINT_PUBLIC_KEY_DIR"
      require_public "${KF_POSTGRES_SERVER_DIR:-/usr/lib/postgresql/18/bin}"
      consumer_env+=("KF_DRILL_DECRYPTION_KEY_FILE=$CREDENTIALS_DIRECTORY/backup-decryption-key"
        "S3_SECRET_ACCESS_KEY_FILE=$CREDENTIALS_DIRECTORY/s3-secret-access-key"
        "KF_DRILL_WORK_ROOT=$TMPDIR" KF_DRILL_OFFSITE_SOURCE=b2
        "KF_DRILL_OFFSITE_LABEL=$KF_DRILL_OFFSITE_LABEL"
        "CHECKPOINT_PUBLIC_KEY_DIR=$CHECKPOINT_PUBLIC_KEY_DIR"
        "KF_POSTGRES_SERVER_DIR=${KF_POSTGRES_SERVER_DIR:-/usr/lib/postgresql/18/bin}"
        "S3_ENDPOINT=${S3_ENDPOINT:-}" "S3_REGION=${S3_REGION:-}"
        "S3_ACCESS_KEY_ID=${S3_ACCESS_KEY_ID:-}" "S3_BUCKET_ARTIFACTS=${S3_BUCKET_ARTIFACTS:-}"
        "S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-false}")
      args=(/srv/kf-backups)
    fi
    ;;
esac
# Only these file bindings and public settings reach the fixed child. No whole
# environment, arbitrary executable, legacy signer, inline key or fallback.
env -i "${consumer_env[@]}" /usr/bin/bash "$ROOT/scripts/$script" "${args[@]}"
