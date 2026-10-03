#!/usr/bin/env bash
# Fake fixed callee for a public PID 1 binding proof; no SQL/provider/GPG operation.
set -euo pipefail
case "$(basename -- "${BASH_SOURCE[0]}")" in
  backup.sh) role=backup ;;
  backup-offsite.sh) role=offsite ;;
  restore-drill.sh) role=drill ;;
  *) exit 90 ;;
esac
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
for name in DATABASE_URL PGPASSFILE KF_PGPASS_OWNED UNRELATED_SECRET KF_B2_APPLICATION_KEY S3_SECRET_ACCESS_KEY KF_MIGRATOR_DATABASE_URL; do
  [ -z "${!name:-}" ] || { echo "public callee refused inherited $name" >&2; exit 91; }
done
[ "$DATABASE_URL_FILE" = "$CREDENTIALS_DIRECTORY/database-url" ] || exit 92
[ "$KF_SECRET_CUSTODY" = systemd ] && [ "$(stat -c '%u:%a' "$TMPDIR")" = "$EUID:700" ] || exit 93
case "$role" in
  backup)
    [ "$#" = 1 ] && [[ "$1" =~ ^/srv/kf-backups/[0-9]{8}T[0-9]{6}Z$ ]] || exit 94
    [ "$PRESERVATION_SIGNING_KEY_PATH" = "$CREDENTIALS_DIRECTORY/preservation-signing-key" ] || exit 95
    [ -z "${KF_DRILL_DECRYPTION_KEY_FILE:-}" ] && [ -z "${S3_SECRET_ACCESS_KEY_FILE:-}" ] &&
      [ -z "${KF_B2_APPLICATION_KEY_FILE:-}" ] || exit 96
    ;;
  offsite)
    [ "$#" = 3 ] && [ "$1" = /srv/kf-backups/20261003T000002Z ] && [ "$2" = b2 ] &&
      [ "$3" = 'public label with spaces' ] || exit 94
    [ -z "${PRESERVATION_SIGNING_KEY_PATH:-}" ] && [ -z "${KF_DRILL_DECRYPTION_KEY_FILE:-}" ] &&
      [ -z "${S3_SECRET_ACCESS_KEY_FILE:-}" ] || exit 96
    ;;
  drill)
    [ "$#" = 1 ] && [ "$1" = /srv/kf-backups ] || exit 94
    [ "$KF_DRILL_WORK_ROOT" = "$TMPDIR" ] &&
      [ "$KF_DRILL_DECRYPTION_KEY_FILE" = "$CREDENTIALS_DIRECTORY/backup-decryption-key" ] &&
      [ "$S3_SECRET_ACCESS_KEY_FILE" = "$CREDENTIALS_DIRECTORY/s3-secret-access-key" ] || exit 95
    [ -z "${PRESERVATION_SIGNING_KEY_PATH:-}" ] || exit 96
    ;;
esac
if [ "$role" != backup ]; then
  [ "$KF_B2_S3_ENDPOINT_FILE" = "$CREDENTIALS_DIRECTORY/b2-endpoint" ] &&
    [ "$KF_B2_BUCKET_NAME_FILE" = "$CREDENTIALS_DIRECTORY/b2-bucket" ] &&
    [ "$KF_B2_APPLICATION_KEY_ID_FILE" = "$CREDENTIALS_DIRECTORY/b2-key-id" ] &&
    [ "$KF_B2_APPLICATION_KEY_FILE" = "$CREDENTIALS_DIRECTORY/b2-key" ] || exit 95
fi
. "$ROOT/scripts/lib/secret.sh"
. "$ROOT/scripts/lib/preservation-secrets.sh"
kf_preservation_database_child "$DATABASE_URL_FILE" /usr/bin/bash -c '
  test "$(stat -c "%u:%a:%h" "$DATABASE_URL_FILE")" = "$EUID:400:1"
  test -z "${PGPASSFILE:-}"
  test -z "${DATABASE_URL:-}"
'
if [ "$role" = backup ]; then
  kf_prepare_preservation_signing_key
  [ "$(stat -c '%u:%a:%h' "$PRESERVATION_SIGNING_KEY_PATH")" = "$EUID:400:1" ] || exit 97
elif [ "$role" = drill ]; then
  kf_validate_drill_workspace
  kf_validate_backup_decryption_key "$KF_DRILL_DECRYPTION_KEY_FILE"
  kf_preservation_object_child "$S3_SECRET_ACCESS_KEY_FILE" /usr/bin/bash -c '
    test "$(stat -c "%u:%a:%h" "$S3_SECRET_ACCESS_KEY_FILE")" = "$EUID:400:1"
    test -z "${DATABASE_URL_FILE:-}"
  '
fi
printf 'public native binding %s PASS\n' "$role"
if [ "${PRESERVATION_SIGNING_KEY_ID:-}" = public-failure ]; then exit 37; fi
