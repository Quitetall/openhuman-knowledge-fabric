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
# Usage: scripts/restore-verify.sh <backup-directory> <target-database-url>

set -euo pipefail

BACKUP="${1:?usage: restore-verify.sh <backup-directory> <target-database-url>}"
TARGET="${2:?usage: restore-verify.sh <backup-directory> <target-database-url>}"
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

echo "==> restore verified: $BACKUP -> $TARGET"
