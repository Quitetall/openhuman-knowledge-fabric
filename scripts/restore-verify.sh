#!/usr/bin/env bash
#
# Restore a backup and prove it restored.
#
# A backup is not valid until it has been restored. This script proves database round-trip,
# checkpoint trust, and external object-store recovery as separate dimensions. Only all three
# may produce a generic verified outcome; any missing dimension is recorded partial and exits
# nonzero.
#
# It refuses to touch a database that already has a `core` schema. Restoring over live records
# is the failure mode this whole system exists to prevent, and an operator running a drill at
# 3am should not be one typo away from it.
#
# Usage: scripts/restore-verify.sh <backup-directory> <target-database-url-file>
#                                  [ledger-database-url-file]
#
# Connection strings are read only from owner-only files. Accepting one as an argument would
# expose its password in /proc before this script had any chance to sanitize it.
#
#   [ledger-database-url-file]  where to record that this drill happened — normally the
#                 PRODUCTION database, not the target. A drill recorded in the scratch database
#                 is discarded with it, and readiness keeps reporting that no backup has ever
#                 been restored. Omitting it is allowed and says so at the end, loudly, because
#                 the consequence is visible in readiness rather than only in this output.

set -euo pipefail

RESTORE_STARTED_EPOCH="$(date +%s)"

BACKUP="${1:?usage: restore-verify.sh <backup-directory> <target-url-file> [ledger-url-file]}"
TARGET_URL_FILE="${2:?usage: restore-verify.sh <backup-directory> <target-url-file> [ledger-url-file]}"
LEDGER_URL_FILE="${3:-}"

: "${PRESERVATION_SIGNING_KEY_PATH:?set PRESERVATION_SIGNING_KEY_PATH for the verification re-export}"
: "${PRESERVATION_SIGNING_KEY_ID:?set PRESERVATION_SIGNING_KEY_ID for the verification re-export}"
: "${PRESERVATION_TRUST_STORE_DIR:?set PRESERVATION_TRUST_STORE_DIR to the historical public-key directory}"

# shellcheck source=lib/secret.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/secret.sh"
kf_configure_postgres_client
TARGET="$(kf_read_secret_file "$TARGET_URL_FILE" TARGET_DATABASE_URL_FILE)"
LEDGER=""
if [ -n "$LEDGER_URL_FILE" ]; then
  LEDGER="$(kf_read_secret_file "$LEDGER_URL_FILE" LEDGER_DATABASE_URL_FILE)"
fi

# Both connection strings, so neither password reaches argv where every account on this host
# could read it out of /proc/<pid>/cmdline.
TARGET="$(kf_pgpass_url "$TARGET")"
if [ -n "$LEDGER" ]; then
  LEDGER="$(kf_pgpass_url "$LEDGER")"
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
chmod 700 "$WORK"
VERIFIED_BACKUP="$WORK/verified-backup"
# Through the dispatcher, not a bare `trap`: sourcing secret.sh already registered the removal
# of the temporary password file on EXIT, and `trap ... EXIT` REPLACES rather than adds. A bare
# trap here left a 0600 file containing a production password in /tmp whenever this script was
# run standalone.
kf_at_exit 'rm -rf "$WORK"'

echo "==> checking the backup before trusting it"
# Root signature is first. It authenticates a closed regular-file set and exact bytes for the
# SQL and pg_restore inputs below. SHA256SUMS alone is attacker-recomputable and therefore
# cannot authorize executing roles.sql or loading dump.pgcustom.
node "$ROOT/packages/export/dist/cli.js" verify-backup "$BACKUP" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR" \
  --stage "$VERIFIED_BACKUP"
node "$ROOT/packages/export/dist/cli.js" verify "$VERIFIED_BACKUP/export" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR"

echo "==> checking the target is empty"
EXISTING="$("$KF_PSQL" "$TARGET" -tAc \
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
"$KF_PSQL" "$TARGET" -q -f "$VERIFIED_BACKUP/roles.sql" >/dev/null 2>&1 || true
MISSING="$("$KF_PSQL" "$TARGET" -tAc "
  select coalesce(string_agg(r, ', '), '')
    from unnest(array['kf_owner_role','kf_migrator','kf_app','kf_worker',
                      'kf_checkpoint','kf_readonly','kf_auditor','kf_backup']) r
   where not exists (select 1 from pg_roles where rolname = r)")"
if [ -n "$MISSING" ]; then
  echo "refusing to restore: the target cluster is missing roles: $MISSING" >&2
  echo "restore verified staged roles.sql as a superuser first" >&2
  exit 1
fi

echo "==> restoring"
"$KF_PSQL" "$TARGET" -v ON_ERROR_STOP=1 -q \
  -c 'create extension if not exists btree_gist'
# --exit-on-error, because a restore that reports success after skipping objects is worse
# than one that fails: it produces a database that looks restored.
"$KF_PG_RESTORE" --dbname="$TARGET" --no-owner --no-privileges --exit-on-error \
  "$VERIFIED_BACKUP/dump.pgcustom"

echo "==> re-exporting from the restored database"
REEXPORT_ARGS=(
  write "$WORK/export"
  --signing-key "$PRESERVATION_SIGNING_KEY_PATH"
  --key-id "$PRESERVATION_SIGNING_KEY_ID"
)
ARCHIVED_CHECKPOINT_KEYS="$VERIFIED_BACKUP/export/trust/checkpoint"
if [ -d "$ARCHIVED_CHECKPOINT_KEYS" ]; then
  # The package signature was checked above, before these historical keys are trusted or used.
  REEXPORT_ARGS+=(--checkpoint-public-key-dir "$ARCHIVED_CHECKPOINT_KEYS")
fi
DATABASE_URL="$TARGET" node "$ROOT/packages/export/dist/cli.js" "${REEXPORT_ARGS[@]}"
node "$ROOT/packages/export/dist/cli.js" verify "$WORK/export" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR"

echo "==> comparing"
# Every file, byte for byte. Comparing only the manifest would pass a restore in which every
# row's content had changed but the counts happened to match.
# Signature sidecars can legitimately name different trusted signing keys after rotation. The
# canonical manifest and every file it authenticates must still be byte-identical; each sidecar
# was independently verified against the same append-only historical trust store above.
if ! diff -r --brief --exclude=manifest.signature.json \
  "$VERIFIED_BACKUP/export" "$WORK/export"; then
  echo "RESTORE VERIFICATION FAILED: the restored database does not re-export identically" >&2
  exit 1
fi
DATABASE_VERIFIED=true
DATABASE_SNAPSHOT_SHA256="$(node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof value.database_snapshot_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.database_snapshot_sha256)) process.exit(1);
  process.stdout.write(value.database_snapshot_sha256);
' "$VERIFIED_BACKUP/backup.manifest.json")"

echo "==> verifying the audit ledger in the restored database"
CHECKPOINT_VERIFIED=false
CHECKPOINT_PROOF_SHA256=""
CHECKPOINT_PROOF="$WORK/checkpoint-proof.txt"
if [ -d "$ARCHIVED_CHECKPOINT_KEYS" ]; then
  # Authenticated archive wins over ambient host configuration: it is the exact historical
  # key set carried by this backup, and it was verified before the restore began.
  DATABASE_URL="$TARGET" CHECKPOINT_PUBLIC_KEY_DIR="$ARCHIVED_CHECKPOINT_KEYS" \
    CHECKPOINT_PUBLIC_KEY_PATH= CHECKPOINT_SIGNING_KEY_PATH= \
    node "$ROOT/apps/checkpoint/dist/main.js" --verify 2>&1 | tee "$CHECKPOINT_PROOF"
  find "$ARCHIVED_CHECKPOINT_KEYS" -type f -print0 | LC_ALL=C sort -z \
    | xargs -0 sha256sum >> "$CHECKPOINT_PROOF"
  CHECKPOINT_VERIFIED=true
  CHECKPOINT_PROOF_SHA256="$(sha256sum "$CHECKPOINT_PROOF" | cut -d' ' -f1)"
elif [ -n "${CHECKPOINT_PUBLIC_KEY_DIR:-}" ]; then
  DATABASE_URL="$TARGET" CHECKPOINT_SIGNING_KEY_PATH= \
    node "$ROOT/apps/checkpoint/dist/main.js" --verify 2>&1 | tee "$CHECKPOINT_PROOF"
  find "$CHECKPOINT_PUBLIC_KEY_DIR" -type f -print0 | LC_ALL=C sort -z \
    | xargs -0 sha256sum >> "$CHECKPOINT_PROOF"
  CHECKPOINT_VERIFIED=true
  CHECKPOINT_PROOF_SHA256="$(sha256sum "$CHECKPOINT_PROOF" | cut -d' ' -f1)"
elif [ -n "${CHECKPOINT_PUBLIC_KEY_PATH:-}" ]; then
  DATABASE_URL="$TARGET" CHECKPOINT_SIGNING_KEY_PATH= \
    node "$ROOT/apps/checkpoint/dist/main.js" --verify 2>&1 | tee "$CHECKPOINT_PROOF"
  sha256sum "$CHECKPOINT_PUBLIC_KEY_PATH" >> "$CHECKPOINT_PROOF"
  CHECKPOINT_VERIFIED=true
  CHECKPOINT_PROOF_SHA256="$(sha256sum "$CHECKPOINT_PROOF" | cut -d' ' -f1)"
else
  # Said out loud rather than skipped silently: without a key, nothing here proves the audit
  # log was not rewritten before the backup was taken.
  echo "SKIPPED: no checkpoint public-key directory — checkpoint signatures were NOT verified" >&2
fi

echo "==> verifying external object-store recovery"
OBJECT_STORE_VERIFIED=false
OBJECT_STORE_PROOF_REF=""
OBJECT_STORE_PROOF_SHA256=""
OBJECT_STORE_PROOF="$WORK/object-store-proof"
if [ -n "${KF_OBJECT_STORE_VERIFY_PROGRAM:-}" ]; then
  if [[ "$KF_OBJECT_STORE_VERIFY_PROGRAM" != /* ]] ||
     [ ! -f "$KF_OBJECT_STORE_VERIFY_PROGRAM" ] ||
     [ -L "$KF_OBJECT_STORE_VERIFY_PROGRAM" ] ||
     [ ! -x "$KF_OBJECT_STORE_VERIFY_PROGRAM" ]; then
    echo "refusing unsafe KF_OBJECT_STORE_VERIFY_PROGRAM: require absolute regular executable" >&2
    exit 1
  fi
  PROGRAM_MODE="$(stat -c '%a' "$KF_OBJECT_STORE_VERIFY_PROGRAM")"
  PROGRAM_UID="$(stat -c '%u' "$KF_OBJECT_STORE_VERIFY_PROGRAM")"
  if [ "${NODE_ENV:-}" != test ] && [ "$PROGRAM_UID" != 0 ]; then
    echo "refusing non-root-owned object-store verifier" >&2
    exit 1
  fi
  if (( (8#$PROGRAM_MODE & 8#022) != 0 )); then
    echo "refusing group/world-writable object-store verifier" >&2
    exit 1
  fi
  if [[ ! "${KF_OBJECT_STORE_PROOF_REF:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,511}$ ]]; then
    echo "KF_OBJECT_STORE_PROOF_REF must be a credential-free stable evidence reference" >&2
    exit 1
  fi
  "$KF_OBJECT_STORE_VERIFY_PROGRAM" "$VERIFIED_BACKUP/export" "$OBJECT_STORE_PROOF"
  if [ ! -f "$OBJECT_STORE_PROOF" ] || [ -L "$OBJECT_STORE_PROOF" ] || [ ! -s "$OBJECT_STORE_PROOF" ]; then
    echo "object-store verifier did not write a non-empty regular proof file" >&2
    exit 1
  fi
  if [ "$(stat -c '%s' "$OBJECT_STORE_PROOF")" -gt 16777216 ]; then
    echo "object-store proof exceeds 16 MiB safety bound" >&2
    exit 1
  fi
  OBJECT_STORE_VERIFIED=true
  OBJECT_STORE_PROOF_REF="$KF_OBJECT_STORE_PROOF_REF"
  OBJECT_STORE_PROOF_SHA256="$(sha256sum "$OBJECT_STORE_PROOF" | cut -d' ' -f1)"
else
  echo "SKIPPED: KF_OBJECT_STORE_VERIFY_PROGRAM absent — object bytes were NOT verified" >&2
fi

OUTCOME=partial
if [ "$DATABASE_VERIFIED" = true ] &&
   [ "$CHECKPOINT_VERIFIED" = true ] &&
   [ "$OBJECT_STORE_VERIFIED" = true ]; then
  OUTCOME=verified
fi
RESTORE_FINISHED_EPOCH="$(date +%s)"
RECOVERY_SECONDS="$((RESTORE_FINISHED_EPOCH - RESTORE_STARTED_EPOCH))"
if [ "$RECOVERY_SECONDS" -lt 1 ]; then RECOVERY_SECONDS=1; fi

echo "==> recording the drill"
# Recorded AFTER the comparison, so only a drill that actually proved something is recorded as
# having proved it. A failure exits earlier under `set -e` and leaves no row — which readiness
# reads as "not restored recently", the correct reading of a drill that did not complete.
if [ -n "$LEDGER" ]; then
  LOCATION="$(cd "$BACKUP" && pwd)"
  # On stdin: psql does not interpolate :'var' in a -c string.
  RUN_ID="$("$KF_PSQL" "$LEDGER" -v ON_ERROR_STOP=1 -tA -v location="$LOCATION" <<'SQL'
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
    "$KF_PSQL" "$LEDGER" -v ON_ERROR_STOP=1 -q \
      -v run="$RUN_ID" -v label="$(echo "$TARGET" | sed -E 's#//[^@/]*@#//#')" \
      -v outcome="$OUTCOME" -v recovery="$RECOVERY_SECONDS" \
      -v database_verified="$DATABASE_VERIFIED" \
      -v database_digest="$DATABASE_SNAPSHOT_SHA256" \
      -v checkpoint_verified="$CHECKPOINT_VERIFIED" \
      -v checkpoint_digest="$CHECKPOINT_PROOF_SHA256" \
      -v object_verified="$OBJECT_STORE_VERIFIED" \
      -v object_ref="$OBJECT_STORE_PROOF_REF" \
      -v object_digest="$OBJECT_STORE_PROOF_SHA256" <<'SQL'
insert into ops.restore_drill
  (backup_run_id, target_label, outcome, recovery_seconds,
   database_verified, database_snapshot_sha256,
   checkpoint_verified, checkpoint_proof_sha256,
   object_store_verified, object_store_proof_ref, object_store_proof_sha256)
values
  (:'run'::uuid, :'label', :'outcome', :'recovery'::integer,
   :'database_verified'::boolean, nullif(:'database_digest', ''),
   :'checkpoint_verified'::boolean, nullif(:'checkpoint_digest', ''),
   :'object_verified'::boolean, nullif(:'object_ref', ''), nullif(:'object_digest', ''));
SQL
    echo "recorded: $OUTCOME restore drill against $LOCATION"
  fi
else
  cat >&2 <<'EOF'

NOT RECORDED: no ledger URL was given, so nothing in the system knows this drill happened.
Readiness will keep reporting that no backup has ever been restored, which will be true of
the record even though it is not true of the world.

    scripts/restore-verify.sh <backup> <target-url-file> <production-url-file>
EOF
fi

if [ "$OUTCOME" != verified ]; then
  echo "RESTORE PARTIAL: database=$DATABASE_VERIFIED checkpoint=$CHECKPOINT_VERIFIED object_store=$OBJECT_STORE_VERIFIED" >&2
  exit 1
fi

echo "==> restore fully verified: $BACKUP -> $TARGET"
