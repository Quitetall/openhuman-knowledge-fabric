#!/usr/bin/env bash
#
# Take a backup.
#
# Two artefacts, because they answer different questions and neither substitutes for the
# other:
#
#   dump.pgcustom   the operational restore. Fast, exact, and readable only by a PostgreSQL
#                   of a compatible major version — which is why it is not the record.
#   export/         the institutional record. RFC 8785 canonical JSON plus a manifest of
#                   SHA-256 digests, readable by anything that reads text. Retention here is
#                   unbounded (ISO 13485 4.2.5, device lifetime undefined), and no database
#                   binary format survives that horizon.
#
# The artifact BYTES are not in either: they live in the object store, and the export carries
# the index and digests that prove the two still agree. Backing up this database without also
# backing up that bucket restores a catalogue of things you no longer have.
#
# Usage: scripts/backup.sh [destination-directory]

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"

DEST="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$DEST"

echo "==> logical dump"
# Custom format: compressed, and selectively restorable, which matters when a restore has to
# omit or reorder something.
pg_dump --format=custom --no-owner --no-privileges --file="$DEST/dump.pgcustom" "$DATABASE_URL"

echo "==> canonical export"
node "$ROOT/packages/export/dist/cli.js" write "$DEST/export"

echo "==> schema"
pg_dump --schema-only --no-owner --no-privileges --file="$DEST/schema.sql" "$DATABASE_URL"

echo "==> cluster roles"
# Roles live in the cluster, not the database, so a `pg_dump` does not contain them — but the
# row-level security policies DO name them (`... to kf_app`). Restoring into a fresh cluster
# without these fails on the first policy, which is a confusing way to discover that half the
# security model was never in the backup.
pg_dumpall --roles-only --no-role-passwords --file="$DEST/roles.sql" --dbname="$DATABASE_URL"

cat > "$DEST/README.md" <<'EOF'
# Backup

| File | What it is |
|---|---|
| `dump.pgcustom` | `pg_restore` input. The operational restore path. |
| `export/` | Canonical RFC 8785 JSON + `manifest.json`. The institutional record. |
| `schema.sql` | The schema alone, for reading without restoring. |
| `roles.sql` | Cluster roles. `pg_dump` does not contain them, but the RLS policies name them. |
| `SHA256SUMS` | Digests of everything above. |

## Verify without a database

    sha256sum -c SHA256SUMS
    node packages/export/dist/cli.js verify export

## Restore and prove it

    scripts/restore-verify.sh <this directory> <target-database-url>

A backup is not valid until it has been restored. `restore-verify.sh` restores, re-exports,
and compares — an untested backup is an assumption, not a control.

## Not included

Artifact bytes. They are in the object store; this holds their digests. Back up the bucket on
the same schedule, or a restore returns a catalogue of things you no longer have.
EOF

echo "==> digests"
# Over the whole backup, so a bit rot or a truncated copy is detectable without a database.
( cd "$DEST" && find . -type f ! -name SHA256SUMS -print0 | sort -z \
    | xargs -0 sha256sum > SHA256SUMS )

echo "==> done: $DEST"
du -sh "$DEST"
