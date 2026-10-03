#!/usr/bin/env bash
# Public fixtures only. Called by the root-only selected-VM driver under PID 1.
set -Eeuo pipefail
release="$1"
plant="$2"
. "$release/scripts/lib/secret.sh"
ROOT="$release"
. "$release/scripts/lib/offsite-b2.sh"
. "$release/scripts/lib/preservation-secrets.sh"

case "$plant" in
  oversized-url|short-key|unknown-name|empty-b2|oversized-b2|empty-preservation|oversized-signer|oversized-recovery)
    case "$plant" in
      oversized-url) name=database-url ;;
      short-key) name=rehearsal-receipt-key ;;
      unknown-name) name=unknown-name ;;
      empty-b2|oversized-b2) name=b2-key ;;
      empty-preservation|oversized-signer) name=preservation-signing-key ;;
      oversized-recovery) name=backup-decryption-key ;;
    esac
    if kf_validate_secret_file "$CREDENTIALS_DIRECTORY/$name"; then
      echo 'planted credential was incorrectly admitted' >&2
      exit 1
    fi
    printf '%s refused: PASS\n' "$plant"
    exit 0
    ;;
  preservation-purpose-mismatch)
    PRESERVATION_SIGNING_KEY_PATH="$CREDENTIALS_DIRECTORY/rehearsal-receipt-key"
    if kf_prepare_preservation_signing_key ||
       kf_validate_backup_decryption_key "$CREDENTIALS_DIRECTORY/preservation-signing-key"; then
      echo 'foreign preservation credential purpose was incorrectly admitted' >&2; exit 1
    fi
    echo 'both foreign preservation credential purposes refused: PASS'
    exit 0
    ;;
  drill-workspace-mismatch)
    KF_DRILL_WORK_ROOT=/var/lib/kf-restore-drill
    if kf_validate_drill_workspace; then
      echo 'disk recovery workspace was incorrectly admitted' >&2; exit 1
    fi
    echo 'systemd recovery work outside private runtime refused: PASS'
    exit 0
    ;;
  b2-purpose-mismatch)
    KF_B2_APPLICATION_KEY_FILE="$CREDENTIALS_DIRECTORY/index-key"
    if kf_b2_value KF_B2_APPLICATION_KEY >/dev/null; then
      echo 'foreign credential purpose was incorrectly admitted' >&2; exit 1
    fi
    echo 'B2 foreign credential purpose refused: PASS'
    exit 0
    ;;
  unsafe-helper)
    if kf_validate_secret_file "$CREDENTIALS_DIRECTORY/database-url"; then
      echo 'unsafe helper was incorrectly executed' >&2
      exit 1
    fi
    echo 'unsafe helper refused: PASS'
    exit 0
    ;;
  valid) ;;
  *) echo 'unknown public fixture plant' >&2; exit 1 ;;
esac

[ "$(kf_read_secret_file "$CREDENTIALS_DIRECTORY/database-url" DATABASE_URL_FILE)" = \
  'postgres://fixture:public-fixture-password@127.0.0.1:5433/public_probe' ]
[ "$(kf_read_secret_file "$CREDENTIALS_DIRECTORY/rehearsal-database-url" KF_REHEARSAL_DATABASE_URL_FILE)" = \
  'postgres://fixture:public-fixture-password@127.0.0.1:5434/public_probe' ]
kf_validate_secret_file "$CREDENTIALS_DIRECTORY/rehearsal-receipt-key"
"$release/tools/kf-credential-custody" "$CREDENTIALS_DIRECTORY"
echo 'named credentials and unchanged index-key interface: PASS'

KF_B2_S3_ENDPOINT_FILE="$CREDENTIALS_DIRECTORY/b2-endpoint"
KF_B2_BUCKET_NAME_FILE="$CREDENTIALS_DIRECTORY/b2-bucket"
KF_B2_APPLICATION_KEY_ID_FILE="$CREDENTIALS_DIRECTORY/b2-key-id"
KF_B2_APPLICATION_KEY_FILE="$CREDENTIALS_DIRECTORY/b2-key"
[ "$(kf_b2_value KF_B2_S3_ENDPOINT)" = 'https://s3.us-west-004.backblazeb2.com' ]
[ "$(kf_b2_value KF_B2_BUCKET_NAME)" = 'opaque-backups' ]
[ "$(kf_b2_value KF_B2_APPLICATION_KEY_ID)" = 'public-fixture-key-id' ]
[ "$(kf_b2_value KF_B2_APPLICATION_KEY)" = 'public-fixture-application-key' ]
unset KF_B2_APPLICATION_KEY_FILE
KF_B2_APPLICATION_KEY='public-fixture-application-key'
if kf_b2_value KF_B2_APPLICATION_KEY >/dev/null; then
  echo 'inline B2 credential fallback was incorrectly admitted in systemd custody' >&2; exit 1
fi
echo 'four named B2 credentials and no inline systemd fallback: PASS'

KF_DRILL_WORK_ROOT="$TMPDIR"
kf_validate_drill_workspace
kf_validate_backup_decryption_key "$CREDENTIALS_DIRECTORY/backup-decryption-key"
PRESERVATION_SIGNING_KEY_PATH="$CREDENTIALS_DIRECTORY/preservation-signing-key"
kf_prepare_preservation_signing_key
[ "$PRESERVATION_SIGNING_KEY_PATH" != "$CREDENTIALS_DIRECTORY/preservation-signing-key" ]
[ "$(stat -c '%u:%a:%h' "$PRESERVATION_SIGNING_KEY_PATH")" = "$EUID:400:1" ]
[ "$(stat -f -c '%t' "$PRESERVATION_SIGNING_KEY_PATH")" = 1021994 ]
[ "$(cat "$PRESERVATION_SIGNING_KEY_PATH")" = 'public-fixture-preservation-signer' ]
if kf_prepare_preservation_signing_key; then
  echo 'a second signing credential preparation was incorrectly admitted' >&2; exit 1
fi
echo 'bounded preservation credentials and owner-only volatile signing input: PASS'

staged="$(env -u PGPASSFILE -u KF_PGPASS_OWNED /usr/bin/bash -c \
  '. "$1/scripts/lib/secret.sh"; . "$1/scripts/lib/preservation-secrets.sh"; PRESERVATION_SIGNING_KEY_PATH="$CREDENTIALS_DIRECTORY/preservation-signing-key"; kf_prepare_preservation_signing_key; printf "%s" "$PRESERVATION_SIGNING_KEY_PATH"' fixture "$release")"
[ -n "$staged" ] && [ ! -e "$staged" ]
echo 'staged preservation signing key removed on exit: PASS'
if failed_stage="$(env -u PGPASSFILE -u KF_PGPASS_OWNED /usr/bin/bash -c \
  '. "$1/scripts/lib/secret.sh"; . "$1/scripts/lib/preservation-secrets.sh"; PRESERVATION_SIGNING_KEY_PATH="$CREDENTIALS_DIRECTORY/preservation-signing-key"; kf_prepare_preservation_signing_key; printf "%s" "$PRESERVATION_SIGNING_KEY_PATH"; exit 7' fixture "$release")"; then
  echo 'planted signing failure unexpectedly succeeded' >&2; exit 1
fi
[ -n "$failed_stage" ] && [ ! -e "$failed_stage" ]
echo 'staged preservation signing key removed on failure: PASS'

DATABASE_URL_FILE="$CREDENTIALS_DIRECTORY/database-url"
kf_resolve_database_url
[[ "$DATABASE_URL" != *public-fixture-password* ]]
[ "$(stat -c '%a' "$PGPASSFILE")" = 600 ]
[ "$(stat -f -c '%t' "$PGPASSFILE")" = 1021994 ]
[ "$(cat "$PGPASSFILE")" = '127.0.0.1:5433:*:fixture:public-fixture-password' ]
echo 'password removed from connection argv and confined to tmpfs: PASS'

# The actual cleanup dispatcher must remove a nested invocation's password file.
cleaned="$(env -u PGPASSFILE -u KF_PGPASS_OWNED /usr/bin/bash -c \
  '. "$1/scripts/lib/secret.sh"; printf "%s" "$PGPASSFILE"' fixture "$release")"
[ -n "$cleaned" ] && [ ! -e "$cleaned" ]
echo 'owned password file removed on exit: PASS'

ln -s "$CREDENTIALS_DIRECTORY/database-url" "$TMPDIR/database-url"
if kf_validate_secret_file "$TMPDIR/database-url"; then
  echo 'credential outside the PID 1 directory was incorrectly admitted' >&2
  exit 1
fi
echo 'credential path outside the declared mount refused: PASS'
