#!/usr/bin/env bash
#
# Take a backup.
#
# Two data artefacts, because they answer different questions and neither substitutes for the
# other. One signed root manifest binds both to the same backup bundle:
#
#   dump.pgcustom   the operational restore. Fast, exact, and readable only by a PostgreSQL
#                   of a compatible major version — which is why it is not the record.
#   export/         the institutional record. RFC 8785 canonical JSON plus an Ed25519-signed
#                   manifest of SHA-256 digests, readable by anything that reads text.
#                   Retention here is unbounded (ISO 13485 4.2.5, device lifetime undefined),
#                   and no database binary format survives that horizon.
#
# The artifact BYTES are not in either: they live in the object store, and the export carries
# the index and digests that prove the two still agree. Backing up this database without also
# backing up that bucket restores a catalogue of things you no longer have.
#
# Usage: scripts/backup.sh [destination-directory]

set -euo pipefail

# DATABASE_URL_FILE where set, DATABASE_URL otherwise. A connection string is a credential;
# see scripts/lib/secret.sh for why the file is preferred and why its mode is checked.
# shellcheck source=lib/secret.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/secret.sh"
kf_resolve_database_url
kf_configure_postgres_client

# A backup without an authenticated origin can be repacked by anybody who can recompute
# SHA-256. The private key remains an external owner-only file; the append-only public trust
# store remains external too, so a package can never nominate the key that makes itself valid.
: "${PRESERVATION_SIGNING_KEY_PATH:?set PRESERVATION_SIGNING_KEY_PATH to an owner-only Ed25519 private key file}"
: "${PRESERVATION_SIGNING_KEY_ID:?set PRESERVATION_SIGNING_KEY_ID to its immutable key id}"
: "${PRESERVATION_TRUST_STORE_DIR:?set PRESERVATION_TRUST_STORE_DIR to the historical public-key directory}"

REQUESTED_DEST="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEST_PARENT_INPUT="$(dirname "$REQUESTED_DEST")"
DEST_NAME="$(basename "$REQUESTED_DEST")"
if [ -z "$DEST_NAME" ] || [ "$DEST_NAME" = "." ] || [ "$DEST_NAME" = "/" ]; then
  echo "refusing unsafe backup destination: $REQUESTED_DEST" >&2
  exit 1
fi
mkdir -p "$DEST_PARENT_INPUT"
DEST_PARENT="$(cd "$DEST_PARENT_INPUT" && pwd)"
FINAL_DEST="$DEST_PARENT/$DEST_NAME"
if [ -e "$FINAL_DEST" ]; then
  echo "refusing to overwrite existing backup destination: $FINAL_DEST" >&2
  exit 1
fi

# Build beside final name. All bytes and metadata are flushed before one same-filesystem rename
# publishes complete tree. A crash or failed command leaves no directory that looks finished.
STAGING_DEST="$(mktemp -d "$DEST_PARENT/.${DEST_NAME}.partial.XXXXXX")"
DEST="$STAGING_DEST"
backup_staging_cleanup() {
  if [ -n "${STAGING_DEST:-}" ] && [ -d "$STAGING_DEST" ]; then
    rm -rf -- "$STAGING_DEST"
  fi
}
kf_at_exit backup_staging_cleanup

SNAPSHOT_COORDINATOR_PID=""
SNAPSHOT_COORDINATOR_IN_FD=""
SNAPSHOT_COORDINATOR_OUT_FD=""

snapshot_coordinator_cleanup() {
  # Best-effort only on EXIT. Normal path calls this explicitly and observes `wait` status.
  if [ -n "$SNAPSHOT_COORDINATOR_IN_FD" ]; then
    printf 'rollback;\n\\q\n' >&"$SNAPSHOT_COORDINATOR_IN_FD" 2>/dev/null || true
    exec {SNAPSHOT_COORDINATOR_IN_FD}>&- 2>/dev/null || true
    SNAPSHOT_COORDINATOR_IN_FD=""
  fi
  if [ -n "$SNAPSHOT_COORDINATOR_PID" ]; then
    wait "$SNAPSHOT_COORDINATOR_PID" 2>/dev/null || true
    SNAPSHOT_COORDINATOR_PID=""
  fi
  if [ -n "$SNAPSHOT_COORDINATOR_OUT_FD" ]; then
    exec {SNAPSHOT_COORDINATOR_OUT_FD}<&- 2>/dev/null || true
    SNAPSHOT_COORDINATOR_OUT_FD=""
  fi
}

# Through shared dispatcher: replacing EXIT trap here would discard secret.sh's PGPASSFILE
# cleanup and leave database credentials behind in /tmp.
kf_at_exit snapshot_coordinator_cleanup

echo "==> exporting one repeatable-read backup snapshot"
# Coordinator owns snapshot lifetime. Every database artifact below imports same token before
# reading; without this, a write between pg_dump and canonical export creates two individually
# valid artifacts that cannot round-trip against each other.
coproc KF_SNAPSHOT_COORDINATOR {
  exec "$KF_PSQL" "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --quiet \
    --set ON_ERROR_STOP=1
}
SNAPSHOT_COORDINATOR_PID="$KF_SNAPSHOT_COORDINATOR_PID"
SNAPSHOT_COORDINATOR_OUT_FD="${KF_SNAPSHOT_COORDINATOR[0]}"
SNAPSHOT_COORDINATOR_IN_FD="${KF_SNAPSHOT_COORDINATOR[1]}"
printf '%s\n' \
  'begin transaction isolation level repeatable read read only;' \
  'select pg_export_snapshot();' >&"$SNAPSHOT_COORDINATOR_IN_FD"
if ! IFS= read -r SNAPSHOT_ID <&"$SNAPSHOT_COORDINATOR_OUT_FD"; then
  echo "snapshot coordinator exited before exporting a snapshot" >&2
  exit 1
fi
if [[ ! "$SNAPSHOT_ID" =~ ^[0-9A-F]{8}-[0-9A-F]{8}-[0-9]+$ ]]; then
  echo "refusing malformed PostgreSQL exported snapshot token" >&2
  exit 1
fi
echo "==> shared snapshot ready"

# Deterministic concurrency seam for real integration tests. Never active in deployed profiles:
# production must fail rather than pause a backup on an attacker-controlled FIFO.
if [ -n "${KF_BACKUP_TEST_SNAPSHOT_BARRIER:-}" ]; then
  if [ "${NODE_ENV:-}" != "test" ] || [ ! -p "$KF_BACKUP_TEST_SNAPSHOT_BARRIER" ]; then
    echo "KF_BACKUP_TEST_SNAPSHOT_BARRIER requires NODE_ENV=test and a named pipe" >&2
    exit 1
  fi
  printf 'snapshot-ready\n' > "$KF_BACKUP_TEST_SNAPSHOT_BARRIER"
  IFS= read -r BARRIER_RESPONSE < "$KF_BACKUP_TEST_SNAPSHOT_BARRIER"
  if [ "$BARRIER_RESPONSE" != "continue" ]; then
    echo "snapshot test barrier received an invalid response" >&2
    exit 1
  fi
fi

echo "==> logical dump"
# Custom format: compressed, and selectively restorable, which matters when a restore has to
# omit or reorder something.
"$KF_PG_DUMP" --format=custom --no-owner --no-privileges --snapshot="$SNAPSHOT_ID" \
  --file="$DEST/dump.pgcustom" "$DATABASE_URL"

echo "==> canonical export"
EXPORT_WRITE_ARGS=(
  write "$DEST/export"
  --signing-key "$PRESERVATION_SIGNING_KEY_PATH"
  --key-id "$PRESERVATION_SIGNING_KEY_ID"
  --snapshot "$SNAPSHOT_ID"
)
if [ -n "${CHECKPOINT_PUBLIC_KEY_DIR:-}" ]; then
  # Public verification material only. The CLI rejects links, unexpected filenames, private
  # PEM blocks, invalid Ed25519 keys, and a configured-but-absent/empty directory.
  EXPORT_WRITE_ARGS+=(--checkpoint-public-key-dir "$CHECKPOINT_PUBLIC_KEY_DIR")
fi
node "$ROOT/packages/export/dist/cli.js" "${EXPORT_WRITE_ARGS[@]}"

echo "==> authenticating canonical export through the external trust store"
node "$ROOT/packages/export/dist/cli.js" verify "$DEST/export" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR"

echo "==> schema"
"$KF_PG_DUMP" --schema-only --no-owner --no-privileges --snapshot="$SNAPSHOT_ID" \
  --file="$DEST/schema.sql" "$DATABASE_URL"

echo "==> cluster roles"
# Roles live in the cluster, not the database, so a `pg_dump` does not contain them — but the
# row-level security policies DO name them (`... to kf_app`). Restoring into a fresh cluster
# without these fails on the first policy, which is a confusing way to discover that half the
# security model was never in the backup.
"$KF_PG_DUMPALL" --roles-only --no-role-passwords --file="$DEST/roles.sql" \
  --dbname="$DATABASE_URL"

echo "==> PostgreSQL client identity"
{
  "$KF_PSQL" --version
  "$KF_PG_DUMP" --version
  "$KF_PG_DUMPALL" --version
  "$KF_PG_RESTORE" --version
} > "$DEST/postgres-client-versions.txt"

# Snapshot has now covered custom dump, schema dump, and canonical export. End coordinator
# before hashing so an accidentally stalled signing operation cannot retain a database snapshot.
printf 'rollback;\n\\q\n' >&"$SNAPSHOT_COORDINATOR_IN_FD"
exec {SNAPSHOT_COORDINATOR_IN_FD}>&-
SNAPSHOT_COORDINATOR_IN_FD=""
if ! wait "$SNAPSHOT_COORDINATOR_PID"; then
  echo "snapshot coordinator failed" >&2
  exit 1
fi
SNAPSHOT_COORDINATOR_PID=""
exec {SNAPSHOT_COORDINATOR_OUT_FD}<&-
SNAPSHOT_COORDINATOR_OUT_FD=""

cat > "$DEST/README.md" <<'EOF'
# Backup

| File | What it is |
|---|---|
| `dump.pgcustom` | `pg_restore` input. The operational restore path. |
| `export/` | Canonical RFC 8785 JSON + `manifest.json` + Ed25519 signature sidecar. The institutional record. |
| `schema.sql` | The schema alone, for reading without restoring. |
| `roles.sql` | Cluster roles. `pg_dump` does not contain them, but the RLS policies name them. |
| `postgres-client-versions.txt` | Exact PostgreSQL 18 client identities used to create restore inputs. |
| `SHA256SUMS` | Human/tool-compatible digests of content artifacts. |
| `backup.manifest.json` | Closed file set, exact sizes and SHA-256 digests for every file above. |
| `backup.manifest.signature.json` | Ed25519 authentication of the exact root manifest. |

## Verify without a database

    node packages/export/dist/cli.js verify-backup . \
      --trust-store /external/preservation-trust.d
    node packages/export/dist/cli.js verify export \
      --trust-store /external/preservation-trust.d

## Restore and prove it

    scripts/restore-verify.sh <this directory> <owner-only-target-url-file>

A backup is not valid until it has been restored. `restore-verify.sh` restores, re-exports,
compares, verifies checkpoint trust, and requires a configured external object-store verifier.
Database-only recovery is recorded as partial and exits nonzero.

## Not included

Artifact bytes. They are in the object store; this holds their digests. Back up the bucket on
the same schedule, or a restore returns a catalogue of things you no longer have.

Private signing keys and the authoritative preservation trust store are also not included.
They remain in separately controlled external custody. When configured, checkpoint **public**
verification keys are copied byte-for-byte under `export/trust/checkpoint/` and authenticated by
the signed manifest so historical audit checkpoints remain verifiable after host loss.
EOF

echo "==> digests"
# Compatibility sums intentionally do not list themselves or root signature sidecars. Signed
# root manifest created next authenticates SHA256SUMS plus every artifact without recursion.
( cd "$DEST" && find . -type f ! -name SHA256SUMS \
    ! -name backup.manifest.json ! -name backup.manifest.signature.json -print0 | sort -z \
    | xargs -0 sha256sum > SHA256SUMS )

echo "==> signing complete backup bundle"
node "$ROOT/packages/export/dist/cli.js" sign-backup "$DEST" \
  --signing-key "$PRESERVATION_SIGNING_KEY_PATH" \
  --key-id "$PRESERVATION_SIGNING_KEY_ID" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR"

echo "==> authenticating complete backup bundle through external trust store"
node "$ROOT/packages/export/dist/cli.js" verify-backup "$DEST" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR"

echo "==> durably publishing complete backup"
# GNU sync -f issues syncfs(2) for filesystem containing staging tree: payload data, signed
# sidecars, nested directory entries, and metadata are durable before rename. Parent flush then
# makes rename itself durable before ledger records success.
sync -f "$STAGING_DEST"
mv -- "$STAGING_DEST" "$FINAL_DEST"
STAGING_DEST=""
DEST="$FINAL_DEST"
sync -f "$DEST_PARENT"

echo "==> recording the backup"
# Written to the database this is a backup OF, which necessarily means the dump does not
# contain its own record — a backup cannot contain the fact that it finished.
#
# Not optional, and not tolerant of failure: a backup nothing recorded is one the readiness
# check will keep reporting as absent, and an operator who saw "done" will believe otherwise.
# `set -e` is doing the work here on purpose.
MANIFEST_DIGEST="$(sha256sum "$DEST/backup.manifest.json" | cut -d' ' -f1)"
BYTE_SIZE="$(du -sb "$DEST" | cut -f1)"
LOCATION="$(cd "$DEST" && pwd)"

# `-v` plus `:'name'` rather than string interpolation: psql quotes and escapes the value, so
# a destination path containing a quote is a path and not a SQL fragment.
# Fed on stdin rather than with -c: psql does NOT interpolate :'var' in a -c string, and the
# failure is a syntax error at the colon rather than anything that reads like the cause.
"$KF_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -v started="$STARTED_AT" -v location="$LOCATION" \
  -v digest="$MANIFEST_DIGEST" -v bytes="$BYTE_SIZE" <<'SQL'
insert into ops.backup_run
  (started_at, finished_at, kind, location, manifest_digest, byte_size, database_name)
values
  (:'started'::timestamptz, now(), 'logical', :'location',
   :'digest', :'bytes'::bigint, current_database());
SQL

echo "==> done: $DEST"
du -sh "$DEST"

cat <<'EOF'

This backup is on the same host as the database. Until a copy reaches somewhere else,
readiness reports it degraded — a backup beside the thing it backs up survives a dropped
table and not a lost host.

    scripts/backup-offsite.sh <this directory> <destination> <label>
EOF
