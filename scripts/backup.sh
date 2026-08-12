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

# DATABASE_URL_FILE where set, DATABASE_URL otherwise. A connection string is a credential;
# see scripts/lib/secret.sh for why the file is preferred and why its mode is checked.
# shellcheck source=lib/secret.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/secret.sh"
kf_resolve_database_url

DEST="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
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

echo "==> recording the backup"
# Written to the database this is a backup OF, which necessarily means the dump does not
# contain its own record — a backup cannot contain the fact that it finished.
#
# Not optional, and not tolerant of failure: a backup nothing recorded is one the readiness
# check will keep reporting as absent, and an operator who saw "done" will believe otherwise.
# `set -e` is doing the work here on purpose.
MANIFEST_DIGEST="$(sha256sum "$DEST/SHA256SUMS" | cut -d' ' -f1)"
BYTE_SIZE="$(du -sb "$DEST" | cut -f1)"
LOCATION="$(cd "$DEST" && pwd)"

# `-v` plus `:'name'` rather than string interpolation: psql quotes and escapes the value, so
# a destination path containing a quote is a path and not a SQL fragment.
# Fed on stdin rather than with -c: psql does NOT interpolate :'var' in a -c string, and the
# failure is a syntax error at the colon rather than anything that reads like the cause.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
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
