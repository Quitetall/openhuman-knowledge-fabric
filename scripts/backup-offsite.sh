#!/usr/bin/env bash
#
# Copy a backup somewhere that is not this host, and prove it arrived intact.
#
# A backup beside the database it came from survives a dropped table. It does not survive a
# lost host, a filled volume, a ransomware event, or the building. Those are the failures that
# backups exist for, so a backup with no copy elsewhere is reported degraded by readiness until
# this has run.
#
# The copy is verified AT THE DESTINATION, by re-checking the digests there. A transfer that
# silently truncated produces a directory of the right shape and the wrong contents, and the
# time to discover that is now — not during a restore somebody is attempting under pressure.
#
# Usage: scripts/backup-offsite.sh <backup-directory> <destination> <label> [--same-host]
#
#   <destination>  anything rsync accepts: /mnt/vault/kf, user@host:/srv/backups/kf
#   <label>        the name this destination is known by, recorded in the ledger. Not the
#                  destination itself — that can carry a username, and the ledger is readable
#                  by every read role in the system.
#   --same-host    record the copy as NOT off-site. For a second volume on the same machine,
#                  which is a real mitigation for some failures and not for the ones that
#                  matter most.

set -euo pipefail

# DATABASE_URL_FILE where set, DATABASE_URL otherwise. A connection string is a credential;
# see scripts/lib/secret.sh for why the file is preferred and why its mode is checked.
# shellcheck source=lib/secret.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/secret.sh"
kf_resolve_database_url
kf_configure_postgres_client

BACKUP="${1:?usage: backup-offsite.sh <backup-directory> <destination> <label> [--same-host]}"
DESTINATION="${2:?usage: backup-offsite.sh <backup-directory> <destination> <label> [--same-host]}"
LABEL="${3:?usage: backup-offsite.sh <backup-directory> <destination> <label> [--same-host]}"
: "${PRESERVATION_TRUST_STORE_DIR:?set PRESERVATION_TRUST_STORE_DIR to the historical public-key directory}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OFFSITE=true
# An `if`, not `[ ... ] && ...`: under `set -e` a false test at the end of an && list is a
# failing statement, and the script would exit whenever --same-host was NOT passed.
if [ "${4:-}" = "--same-host" ]; then
  OFFSITE=false
fi

LOCATION="$(cd "$BACKUP" && pwd)"
NAME="$(basename "$LOCATION")"

echo "==> checking the source before copying it"
# A corrupt source copied faithfully is a corrupt backup in two places. SHA256SUMS remains a
# compatibility check, but the signed root manifest is the authority for restore-critical
# sidecars and the closed file set.
node "$ROOT/packages/export/dist/cli.js" verify-backup "$LOCATION" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR"
( cd "$BACKUP" && sha256sum -c SHA256SUMS --quiet )
SOURCE_MANIFEST_DIGEST="$(sha256sum "$LOCATION/backup.manifest.json" | cut -d' ' -f1)"
SOURCE_SIGNATURE_DIGEST="$(sha256sum "$LOCATION/backup.manifest.signature.json" | cut -d' ' -f1)"
SOURCE_SUMS_DIGEST="$(sha256sum "$LOCATION/SHA256SUMS" | cut -d' ' -f1)"

echo "==> checking this backup is one we recorded"
# The ledger is the thing readiness reads. Copying a directory it has never heard of would
# produce a copy row pointing at nothing, so the run has to exist first.
# Fed on stdin rather than with -c: psql does NOT interpolate :'var' in a -c string, and the
# failure is a syntax error at the colon rather than anything that reads like the cause.
RUN_ROW="$("$KF_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -F $'\t' -v location="$LOCATION" <<'SQL'
select id, manifest_digest from ops.backup_run where location = :'location';
SQL
)"
IFS=$'\t' read -r RUN_ID RUN_MANIFEST_DIGEST <<< "$RUN_ROW"
if [ -z "$RUN_ID" ]; then
  echo "refusing to record: no ops.backup_run row for $LOCATION" >&2
  echo "this directory was not produced by scripts/backup.sh against this database" >&2
  exit 1
fi
if [ "$SOURCE_MANIFEST_DIGEST" != "$RUN_MANIFEST_DIGEST" ]; then
  echo "refusing to copy: source root manifest digest differs from ops.backup_run" >&2
  exit 1
fi

echo "==> copying to $DESTINATION"
# --partial off by omission: a half-transferred directory should not be left looking like a
# backup. Either it lands complete or the next run starts again.
#
# --delete is scoped to "$DESTINATION/$NAME/" — this one backup's own directory, named after a
# source that was digest-verified two lines up. It cannot reach other backups at the
# destination. What it does do is make a retry after a partial transfer converge on the source
# rather than accumulate.
rsync --archive --checksum --delete --delay-updates --fsync \
  "$LOCATION/" "$DESTINATION/$NAME/"

echo "==> verifying at the destination"
# Re-checked THERE, not here. Verifying the source again would prove only that the source is
# still fine, which was never the question.
case "$DESTINATION" in
  *:*)
    REMOTE_HOST="${DESTINATION%%:*}"
    REMOTE_PATH="${DESTINATION#*:}"
    printf -v REMOTE_DIRECTORY_QUOTED '%q' "$REMOTE_PATH/$NAME"
    ssh "$REMOTE_HOST" "cd -- $REMOTE_DIRECTORY_QUOTED && sha256sum -c SHA256SUMS --quiet"
    DESTINATION_MANIFEST_DIGEST="$(ssh "$REMOTE_HOST" "sha256sum $REMOTE_DIRECTORY_QUOTED/backup.manifest.json" | cut -d' ' -f1)"
    DESTINATION_SIGNATURE_DIGEST="$(ssh "$REMOTE_HOST" "sha256sum $REMOTE_DIRECTORY_QUOTED/backup.manifest.signature.json" | cut -d' ' -f1)"
    DESTINATION_SUMS_DIGEST="$(ssh "$REMOTE_HOST" "sha256sum $REMOTE_DIRECTORY_QUOTED/SHA256SUMS" | cut -d' ' -f1)"
    ssh "$REMOTE_HOST" "sync -f -- $REMOTE_DIRECTORY_QUOTED"
    ;;
  *)
    node "$ROOT/packages/export/dist/cli.js" verify-backup "$DESTINATION/$NAME" \
      --trust-store "$PRESERVATION_TRUST_STORE_DIR"
    ( cd "$DESTINATION/$NAME" && sha256sum -c SHA256SUMS --quiet )
    DESTINATION_MANIFEST_DIGEST="$(sha256sum "$DESTINATION/$NAME/backup.manifest.json" | cut -d' ' -f1)"
    DESTINATION_SIGNATURE_DIGEST="$(sha256sum "$DESTINATION/$NAME/backup.manifest.signature.json" | cut -d' ' -f1)"
    DESTINATION_SUMS_DIGEST="$(sha256sum "$DESTINATION/$NAME/SHA256SUMS" | cut -d' ' -f1)"
    sync -f -- "$DESTINATION/$NAME"
    ;;
esac

if [ "$DESTINATION_MANIFEST_DIGEST" != "$RUN_MANIFEST_DIGEST" ]; then
  echo "the copy at $DESTINATION does not match the recorded root manifest" >&2
  exit 1
fi
if [ "$DESTINATION_SIGNATURE_DIGEST" != "$SOURCE_SIGNATURE_DIGEST" ]; then
  echo "the copy at $DESTINATION does not match the source root manifest signature" >&2
  exit 1
fi
if [ "$DESTINATION_SUMS_DIGEST" != "$SOURCE_SUMS_DIGEST" ]; then
  echo "the copy at $DESTINATION does not match the source compatibility sums" >&2
  exit 1
fi
DIGEST="$DESTINATION_MANIFEST_DIGEST"

echo "==> recording the copy"
"$KF_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -v run="$RUN_ID" -v label="$LABEL" -v offsite="$OFFSITE" -v digest="$DIGEST" <<'SQL'
insert into ops.backup_copy (backup_run_id, destination_label, offsite, manifest_digest)
values (:'run'::uuid, :'label', :'offsite'::boolean, :'digest')
-- Re-copying the same backup to the same destination is a repeat of an event that already
-- happened, not a new one. The digest is unchanged by definition; if it were not, the
-- verification above would have failed before reaching here.
on conflict (backup_run_id, destination_label) do nothing;
SQL

echo "==> copied and verified: $LABEL"
if [ "$OFFSITE" = false ]; then
  cat >&2 <<'EOF'

Recorded as SAME HOST. Readiness will continue to report this backup degraded, because a
copy on the same machine does not survive losing the machine. That is not a bug in the check.
EOF
fi
