#!/usr/bin/env bash
#
# The scheduled restore drill.
#
# Creates a scratch database, restores the newest off-site backup into it, verifies the
# restore, records the drill against the PRODUCTION ledger, and drops the scratch database
# again. This is the thing that turns "we have backups" into a statement anybody should
# believe.
#
# It records into the production ledger deliberately: a drill recorded in the scratch database
# is discarded along with it, and readiness would keep reporting that no backup has ever been
# restored — which would be true of the record and false of the world, the worst of the four
# combinations.
#
# Usage: scripts/restore-drill.sh [backup-root]
#
# Requires DATABASE_URL or DATABASE_URL_FILE — the production database, which is both the
# ledger and the cluster the scratch database is created in.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/secret.sh
. "$ROOT/scripts/lib/secret.sh"
kf_resolve_database_url

BACKUP_ROOT="${1:-/srv/kf-backups}"

echo "==> choosing a backup"
# The newest backup that has actually reached somewhere else. Drilling the on-host copy would
# prove that the dump file is readable and nothing about whether the copy that would be used
# in a real recovery is — and it is the copy that gets used, because in a real recovery the
# host is gone.
LOCATION="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -c "
  select b.location
    from ops.backup_run b
   where exists (select 1 from ops.backup_copy c
                  where c.backup_run_id = b.id and c.offsite)
   order by b.finished_at desc
   limit 1")"

if [ -z "$LOCATION" ]; then
  echo "no backup has an off-site copy recorded — nothing to drill" >&2
  echo "run scripts/backup.sh then scripts/backup-offsite.sh first" >&2
  exit 1
fi

if [ ! -d "$LOCATION" ]; then
  # The recorded location is on this host; the off-site copy is somewhere this script cannot
  # reach. Restoring from the local original is still worth doing and is NOT the same drill,
  # so it says which one it did rather than quietly substituting.
  echo "the recorded location $LOCATION is not present on this host" >&2
  echo "restore the off-site copy by hand, then: scripts/restore-verify.sh <dir> <target> \$DATABASE_URL" >&2
  exit 1
fi

# Names are derived from the clock, so two drills on the same day do not collide and a
# leftover scratch database is obviously dated.
SCRATCH="kf_drill_$(date -u +%Y%m%d%H%M)"
# Everything up to the last slash is the server; what follows is the database name.
SERVER="${DATABASE_URL%/*}"

echo "==> creating scratch database $SCRATCH"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "create database \"$SCRATCH\""

# Dropped whether the drill passes or fails. A failed drill leaves its ROW behind, which is
# the durable evidence; the database itself is scaffolding and a stale one is just a cluster
# slowly filling with abandoned restores.
cleanup() {
  psql "$DATABASE_URL" -q -c "drop database if exists \"$SCRATCH\" with (force)" || true
}
trap cleanup EXIT

echo "==> restoring and verifying"
"$ROOT/scripts/restore-verify.sh" "$LOCATION" "$SERVER/$SCRATCH" "$DATABASE_URL"

echo "==> drill complete"
