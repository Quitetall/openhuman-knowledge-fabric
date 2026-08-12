#!/usr/bin/env bash
#
# Restore a backup and prove it restored.
#
# A backup is not valid until it has been restored. This script is the drill: it restores into
# a target database, re-exports, and compares the result against the export that was taken at
# backup time. If the two disagree, the backup did not preserve what it claimed to.
#
# It refuses to touch a database that already has a `core` schema. Restoring over live records
# is the failure mode this whole system exists to prevent, and an operator running a drill at
# 3am should not be one typo away from it.
#
# Usage: scripts/restore-verify.sh <backup-directory> <target-database-url> [ledger-url]
#
#   [ledger-url]  where to record that this drill happened — normally the PRODUCTION database,
#                 not the target. A drill recorded in the scratch database is discarded with
#                 it, and readiness keeps reporting that no backup has ever been restored.
#                 Omitting it is allowed and says so at the end, loudly, because the
#                 consequence is visible in readiness rather than only in this output.

set -euo pipefail

BACKUP="${1:?usage: restore-verify.sh <backup-directory> <target-database-url> [ledger-url]}"
TARGET="${2:?usage: restore-verify.sh <backup-directory> <target-database-url> [ledger-url]}"
LEDGER="${3:-}"

# shellcheck source=lib/secret.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/secret.sh"
# The ledger may be given as a file too, so a systemd unit never has to put the production
# credential on a command line where `ps` shows it to every account on the host.
if [ -z "$LEDGER" ] && [ -n "${DATABASE_URL_FILE:-}" ]; then
  LEDGER="$(kf_read_secret_file "$DATABASE_URL_FILE" DATABASE_URL_FILE)"
fi

# Both connection strings, so neither password reaches argv where every account on this host
# could read it out of /proc/<pid>/cmdline.
TARGET="$(kf_pgpass_url "$TARGET")"
if [ -n "$LEDGER" ]; then
  LEDGER="$(kf_pgpass_url "$LEDGER")"
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> checking the backup before trusting it"
( cd "$BACKUP" && sha256sum -c SHA256SUMS --quiet )
node "$ROOT/packages/export/dist/cli.js" verify "$BACKUP/export"

echo "==> checking the target is empty"
EXISTING="$(psql "$TARGET" -tAc \
  "select count(*) from information_schema.schemata where schema_name = 'core'")"
if [ "$EXISTING" != "0" ]; then
  echo "refusing to restore: $TARGET already has a 'core' schema" >&2
  echo "drop it deliberately first — this script will not do it for you" >&2
  exit 1
fi

echo "==> restoring cluster roles"
# Roles the RLS policies name. Errors here are expected and ignored — some roles already
# exist in any real cluster — so the check that matters comes after: every role the schema
# depends on must be present, or the restore stops before it starts.
psql "$TARGET" -q -f "$BACKUP/roles.sql" >/dev/null 2>&1 || true
MISSING="$(psql "$TARGET" -tAc "
  select coalesce(string_agg(r, ', '), '')
    from unnest(array['kf_owner_role','kf_migrator','kf_app','kf_worker',
                      'kf_checkpoint','kf_readonly','kf_auditor','kf_backup']) r
   where not exists (select 1 from pg_roles where rolname = r)")"
if [ -n "$MISSING" ]; then
  echo "refusing to restore: the target cluster is missing roles: $MISSING" >&2
  echo "restore $BACKUP/roles.sql as a superuser first" >&2
  exit 1
fi

echo "==> restoring"
psql "$TARGET" -v ON_ERROR_STOP=1 -q -c 'create extension if not exists btree_gist'
# --exit-on-error, because a restore that reports success after skipping objects is worse
# than one that fails: it produces a database that looks restored.
pg_restore --dbname="$TARGET" --no-owner --no-privileges --exit-on-error "$BACKUP/dump.pgcustom"

echo "==> re-exporting from the restored database"
DATABASE_URL="$TARGET" node "$ROOT/packages/export/dist/cli.js" write "$WORK/export"

echo "==> comparing"
# Every file, byte for byte. Comparing only the manifest would pass a restore in which every
# row's content had changed but the counts happened to match.
if ! diff -r --brief "$BACKUP/export" "$WORK/export"; then
  echo "RESTORE VERIFICATION FAILED: the restored database does not re-export identically" >&2
  exit 1
fi

echo "==> verifying the audit ledger in the restored database"
if [ -n "${CHECKPOINT_PUBLIC_KEY_PATH:-}${CHECKPOINT_SIGNING_KEY_PATH:-}" ]; then
  DATABASE_URL="$TARGET" node "$ROOT/apps/checkpoint/dist/main.js" --verify
else
  # Said out loud rather than skipped silently: without a key, nothing here proves the audit
  # log was not rewritten before the backup was taken.
  echo "SKIPPED: no CHECKPOINT_PUBLIC_KEY_PATH — checkpoint signatures were NOT verified" >&2
fi

echo "==> recording the drill"
# Recorded AFTER the comparison, so only a drill that actually proved something is recorded as
# having proved it. A failure exits earlier under `set -e` and leaves no row — which readiness
# reads as "not restored recently", the correct reading of a drill that did not complete.
if [ -n "$LEDGER" ]; then
  LOCATION="$(cd "$BACKUP" && pwd)"
  # On stdin: psql does not interpolate :'var' in a -c string.
  RUN_ID="$(psql "$LEDGER" -v ON_ERROR_STOP=1 -tA -v location="$LOCATION" <<'SQL'
select id from ops.backup_run where location = :'location';
SQL
)"
  if [ -z "$RUN_ID" ]; then
    # Restoring a backup the ledger has never heard of is a legitimate thing to do — an
    # archive from another host, a copy handed over by somebody else. What it is not is
    # evidence about THIS system's backup schedule, so it is not recorded as such.
    echo "NOT RECORDED: no ops.backup_run row in the ledger for $LOCATION" >&2
    echo "the restore verified; it is not evidence about this system's own backups" >&2
  else
    # The label, not the URL: the URL carries a password and this table is readable by every
    # read role in the system.
    psql "$LEDGER" -v ON_ERROR_STOP=1 -q \
      -v run="$RUN_ID" -v label="$(echo "$TARGET" | sed -E 's#//[^@/]*@#//#')" <<'SQL'
insert into ops.restore_drill (backup_run_id, target_label, outcome)
values (:'run'::uuid, :'label', 'verified');
SQL
    echo "recorded: restore drill against $LOCATION"
  fi
else
  cat >&2 <<'EOF'

NOT RECORDED: no ledger URL was given, so nothing in the system knows this drill happened.
Readiness will keep reporting that no backup has ever been restored, which will be true of
the record even though it is not true of the world.

    scripts/restore-verify.sh <backup> <target> <production-database-url>
EOF
fi

echo "==> restore verified: $BACKUP -> $TARGET"
