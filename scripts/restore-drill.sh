#!/usr/bin/env bash
#
# The scheduled restore drill.
#
# Pulls the newest off-site copy BACK from where it was sent, decrypts it, restores it into a
# throwaway PostgreSQL cluster that exists only for this run, verifies the restore, records the
# drill against the PRODUCTION ledger, and destroys the cluster again. This is the thing that
# turns "we have backups" into a statement anybody should believe.
#
# Why the off-site copy and not the local directory: in a real recovery the host is gone, and
# the copy that gets used is the one that was sent away — encrypted, transferred, stored by
# somebody else. Restoring the local original proves that a file on this disk is readable, and
# nothing about the copy that matters. Until 2026-09-23 this script restored the local original
# after selecting it BECAUSE an off-site copy existed.
#
# Why a throwaway cluster and not a scratch database in production: a restore runs roles.sql
# and pg_restore as a privileged role, from a backup whose authenticity is checked by software
# that could itself be wrong. Doing that inside the production cluster put the one database
# this system exists to protect one bug away from the restore. The throwaway cluster listens on
# a Unix socket in a private directory only, on its own port, and is deleted however this ends.
#
# It records into the production ledger deliberately: a drill recorded in the throwaway cluster
# is discarded along with it, and readiness would keep reporting that no backup has ever been
# restored — which would be true of the record and false of the world.
#
# Usage: scripts/restore-drill.sh [backup-root] [--allow-local-fallback]
#
#   --allow-local-fallback  when no off-site copy can be pulled back, restore the local
#                           original instead. Recorded as such in ops.restore_drill.notes, so a
#                           fallback drill never reads as an off-site one.
#
# Environment (normally /etc/kf/backup.env):
#   DATABASE_URL_FILE             the production ledger
#   KF_DRILL_OFFSITE_SOURCE       where the copies were sent, in rsync syntax
#   KF_DRILL_OFFSITE_LABEL        the destination_label backup-offsite.sh recorded for it
#   KF_DRILL_DECRYPTION_KEY_FILE  owner-only OpenPGP secret key for the backup recipient
#   KF_POSTGRES_SERVER_DIR        directory holding PostgreSQL 18 initdb and pg_ctl
#   KF_DRILL_WORK_ROOT            where the throwaway cluster lives (default /var/lib/kf-restore-drill)
#   KF_DRILL_PORT                 its port (default 55432); it never listens on TCP

set -euo pipefail
set +x
set +v
ulimit -c 0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/secret.sh
. "$ROOT/scripts/lib/secret.sh"
# shellcheck source=lib/preservation-secrets.sh
. "$ROOT/scripts/lib/preservation-secrets.sh"
kf_validate_drill_workspace
kf_resolve_database_url
kf_configure_postgres_client

BACKUP_ROOT=/srv/kf-backups
ALLOW_LOCAL_FALLBACK=false
for argument in "$@"; do
  case "$argument" in
    --allow-local-fallback) ALLOW_LOCAL_FALLBACK=true ;;
    -*) echo "usage: restore-drill.sh [backup-root] [--allow-local-fallback]" >&2; exit 64 ;;
    *) BACKUP_ROOT="$argument" ;;
  esac
done

SOURCE="${KF_DRILL_OFFSITE_SOURCE:-}"
LABEL="${KF_DRILL_OFFSITE_LABEL:-}"
WORK_ROOT="${KF_DRILL_WORK_ROOT:-/var/lib/kf-restore-drill}"
PORT="${KF_DRILL_PORT:-55432}"
if [[ ! "$PORT" =~ ^[0-9]{4,5}$ ]]; then
  echo "KF_DRILL_PORT must be a port number" >&2
  exit 1
fi

echo "==> choosing a backup"
# The newest backup with a copy recorded off-site at the configured destination label.
ROW="$("$KF_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -F $'\t' -v label="$LABEL" <<'SQL'
-- drill-selection
select b.id, b.location, b.manifest_digest, coalesce(c.ciphertext_sha256, '-'),
       coalesce(c.provider_object::text, 'null'), c.id
  from ops.backup_run b
  join ops.backup_copy c on c.backup_run_id = b.id and c.offsite
 where :'label' = '' or c.destination_label = :'label'
 order by b.finished_at desc, b.id desc, c.copied_at desc
 limit 1;
SQL
)"
RUN_ID=""
IFS=$'\t' read -r RUN_ID LOCATION MANIFEST_DIGEST CIPHERTEXT_DIGEST PROVIDER_OBJECT COPY_ID <<< "$ROW" || true
PROVIDER_OBJECT="${PROVIDER_OBJECT:-null}"
[ "$CIPHERTEXT_DIGEST" != '-' ] || CIPHERTEXT_DIGEST=''
if [ -z "$RUN_ID" ]; then
  echo "no backup has an off-site copy recorded${LABEL:+ at $LABEL} — nothing to drill" >&2
  echo "run scripts/backup.sh then scripts/backup-offsite.sh first" >&2
  exit 1
fi
NAME="$(basename -- "$LOCATION")"
if [[ ! "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "refusing a recorded backup location with an unexpected name: $LOCATION" >&2
  exit 1
fi

# Why the off-site copy cannot be used, or empty when it can.
OFFSITE_UNAVAILABLE=""
if [ -z "$SOURCE" ] || [ -z "$LABEL" ]; then
  OFFSITE_UNAVAILABLE="KF_DRILL_OFFSITE_SOURCE and KF_DRILL_OFFSITE_LABEL are not both set"
elif [ -z "$CIPHERTEXT_DIGEST" ]; then
  OFFSITE_UNAVAILABLE="the newest off-site copy predates encrypted copies and has no recorded ciphertext digest"
elif [ -z "${KF_DRILL_DECRYPTION_KEY_FILE:-}" ]; then
  OFFSITE_UNAVAILABLE="KF_DRILL_DECRYPTION_KEY_FILE is not set, so the copy cannot be decrypted"
elif [ "$SOURCE" = b2 ] && [ "$PROVIDER_OBJECT" = null ]; then
  OFFSITE_UNAVAILABLE="the selected copy has no recorded cloud version identity"
elif [ "$SOURCE" != b2 ] && [ "$PROVIDER_OBJECT" != null ]; then
  OFFSITE_UNAVAILABLE="the selected cloud copy requires KF_DRILL_OFFSITE_SOURCE=b2"
fi
if [ -n "$OFFSITE_UNAVAILABLE" ] && [ "$ALLOW_LOCAL_FALLBACK" != true ]; then
  echo "refusing to drill: $OFFSITE_UNAVAILABLE" >&2
  echo "a drill of the local original is a different drill; pass --allow-local-fallback to run it and record it as one" >&2
  exit 1
fi

# Everything this run creates lives under one private directory, removed on exit.
install -d -m 0700 -- "$WORK_ROOT"
DRILL_DIR="$(mktemp -d "$WORK_ROOT/drill.XXXXXX")"
chmod 700 "$DRILL_DIR"
PG_CTL=""
CLUSTER="$DRILL_DIR/cluster"
drill_cleanup() {
  if [ -n "$PG_CTL" ] && [ -f "$CLUSTER/postmaster.pid" ]; then
    "$PG_CTL" --pgdata="$CLUSTER" --mode=immediate --wait --silent stop >/dev/null 2>&1 || true
  fi
  rm -rf -- "$DRILL_DIR"
}
# Through the dispatcher, not a bare `trap`, which would discard the password-file cleanup.
kf_at_exit drill_cleanup

if [ -z "$OFFSITE_UNAVAILABLE" ]; then
  echo "==> pulling the off-site copy back from $LABEL"
  if [ "$SOURCE" = b2 ]; then
    # shellcheck source=lib/offsite-b2.sh
    . "$ROOT/scripts/lib/offsite-b2.sh"
    [[ "$COPY_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo 'cloud copy identifier missing' >&2; exit 1; }
    kf_b2_transport pull "$DRILL_DIR/pulled.tar.gpg" "$CIPHERTEXT_DIGEST" "$PROVIDER_OBJECT"
  else
    case "$SOURCE" in s3://*|b2://*|https://*) echo 'use the b2 selector, not a cloud URI' >&2; exit 64 ;; esac
    rsync --checksum -- "$SOURCE/$NAME.tar.gpg" "$DRILL_DIR/pulled.tar.gpg"
  fi
  PULLED_DIGEST="$(sha256sum -- "$DRILL_DIR/pulled.tar.gpg" | cut -d' ' -f1)"
  # The ledger recorded what was sent; anything else that comes back — a replaced object, a
  # truncated one, somebody else's backup under this name — is refused before decryption.
  if [ "$PULLED_DIGEST" != "$CIPHERTEXT_DIGEST" ]; then
    echo "the copy at $LABEL is not the one recorded as sent (ciphertext digest differs)" >&2
    exit 1
  fi

  echo "==> decrypting"
  kf_validate_backup_decryption_key "$KF_DRILL_DECRYPTION_KEY_FILE"
  install -d -m 0700 -- "$DRILL_DIR/gnupg" "$DRILL_DIR/backup"
  gpg --batch --no-tty --quiet --homedir "$DRILL_DIR/gnupg" \
    --import "$KF_DRILL_DECRYPTION_KEY_FILE" 2>/dev/null
  gpg --batch --no-tty --quiet --homedir "$DRILL_DIR/gnupg" --pinentry-mode loopback \
    --passphrase '' --output "$DRILL_DIR/backup.tar" --decrypt "$DRILL_DIR/pulled.tar.gpg"
  rm -f -- "$DRILL_DIR/pulled.tar.gpg"
  # GNU tar refuses members containing `..` and strips leading `/`; --no-same-owner keeps
  # every extracted file ours. The bytes are authenticated by restore-verify.sh next.
  tar --extract --no-same-owner --file="$DRILL_DIR/backup.tar" --directory="$DRILL_DIR/backup"
  rm -f -- "$DRILL_DIR/backup.tar"
  RESTORED_MANIFEST="$(sha256sum -- "$DRILL_DIR/backup/backup.manifest.json" | cut -d' ' -f1)"
  if [ "$RESTORED_MANIFEST" != "$MANIFEST_DIGEST" ]; then
    echo "the decrypted copy is not the backup the ledger recorded (root manifest differs)" >&2
    exit 1
  fi
  RESTORE_SOURCE="$DRILL_DIR/backup"
  NOTES="source=offsite label=$LABEL ciphertext_sha256=$PULLED_DIGEST"
  [ "$SOURCE" != b2 ] || NOTES="$NOTES transport=b2 backup_copy_id=$COPY_ID"
else
  echo "==> LOCAL FALLBACK: $OFFSITE_UNAVAILABLE" >&2
  if [ ! -d "$LOCATION" ]; then
    echo "the recorded location $LOCATION is not present on this host either" >&2
    exit 1
  fi
  RESTORE_SOURCE="$LOCATION"
  NOTES="source=local-fallback reason=$OFFSITE_UNAVAILABLE"
fi

echo "==> starting a throwaway PostgreSQL 18 cluster"
SERVER_DIR="${KF_POSTGRES_SERVER_DIR:?set KF_POSTGRES_SERVER_DIR to the directory holding PostgreSQL 18 initdb and pg_ctl}"
for tool in initdb pg_ctl; do
  if [ ! -x "$SERVER_DIR/$tool" ]; then
    echo "PostgreSQL server tool is missing or not executable: $SERVER_DIR/$tool" >&2
    exit 1
  fi
  if [[ ! "$("$SERVER_DIR/$tool" --version 2>&1)" =~ \(PostgreSQL\)[[:space:]]+18([.]|$) ]]; then
    echo "PostgreSQL 18 required for $SERVER_DIR/$tool" >&2
    exit 1
  fi
done
SOCKET="$DRILL_DIR/socket"
install -d -m 0700 -- "$SOCKET"
# Trust authentication is safe only because nothing but this uid can reach the socket: it is
# in a 0700 directory, and the cluster does not listen on TCP at all.
"$SERVER_DIR/initdb" --pgdata="$CLUSTER" --username=kf_drill --auth=trust --encoding=UTF8 \
  --no-sync --no-instructions >/dev/null
PG_CTL="$SERVER_DIR/pg_ctl"
"$PG_CTL" --pgdata="$CLUSTER" --log="$DRILL_DIR/postgres.log" --wait --silent \
  -o "-c listen_addresses='' -c unix_socket_directories='$SOCKET' -c port=$PORT" start
"$KF_PSQL" "postgresql:///postgres?host=$SOCKET&port=$PORT&user=kf_drill" \
  -v ON_ERROR_STOP=1 -q -c 'create database kf_drill'

RESTORE_TARGET_URL_FILE="$DRILL_DIR/target-url"
RESTORE_LEDGER_URL_FILE="$DRILL_DIR/ledger-url"
install -m 0600 /dev/null "$RESTORE_TARGET_URL_FILE"
install -m 0600 /dev/null "$RESTORE_LEDGER_URL_FILE"
printf '%s\n' "postgresql:///kf_drill?host=$SOCKET&port=$PORT&user=kf_drill" \
  > "$RESTORE_TARGET_URL_FILE"
printf '%s\n' "$DATABASE_URL" > "$RESTORE_LEDGER_URL_FILE"

echo "==> restoring and verifying ($NOTES)"
# The ledger knows this backup by the location backup.sh recorded, not by wherever the pulled
# copy was unpacked, so that is what the drill row is filed under.
KF_RESTORE_LEDGER_LOCATION="$LOCATION" KF_RESTORE_DRILL_NOTES="$NOTES" \
  "$ROOT/scripts/restore-verify.sh" \
  "$RESTORE_SOURCE" "$RESTORE_TARGET_URL_FILE" "$RESTORE_LEDGER_URL_FILE"

echo "==> drill complete from $BACKUP_ROOT ($NOTES)"
