#!/usr/bin/env bash
# Public fixtures only. Called by the root-only selected-VM driver under PID 1.
set -Eeuo pipefail
release="$1"
plant="$2"
. "$release/scripts/lib/secret.sh"

case "$plant" in
  oversized-url|short-key|unknown-name)
    case "$plant" in
      oversized-url) name=database-url ;;
      short-key) name=rehearsal-receipt-key ;;
      unknown-name) name=unknown-name ;;
    esac
    if kf_validate_secret_file "$CREDENTIALS_DIRECTORY/$name"; then
      echo 'planted credential was incorrectly admitted' >&2
      exit 1
    fi
    printf '%s refused: PASS\n' "$plant"
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
