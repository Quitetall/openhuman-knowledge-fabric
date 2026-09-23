#!/usr/bin/env bash
#
# Copy a backup somewhere that is not this host, and prove it arrived intact.
#
# A backup beside the database it came from survives a dropped table. It does not survive a
# lost host, a filled volume, a ransomware event, or the building. Those are the failures that
# backups exist for, so a backup with no copy elsewhere is reported degraded by readiness until
# this has run.
#
# WHAT LEAVES IS CIPHERTEXT. backup.sh encrypts each backup to an operator-held recipient
# public key and writes `<backup>.tar.gpg` beside the directory. This script ships that file
# and only that file: the plaintext bundle, with every record in the database, never crosses
# the host boundary. The decryption key is not on this host.
#
# The copy is verified AT THE DESTINATION, by re-measuring the ciphertext there. A transfer that
# silently truncated produces a file of the right name and the wrong contents, and the time to
# discover that is now — not during a restore somebody is attempting under pressure.
#
# Usage: scripts/backup-offsite.sh <backup-directory> <destination> <label>
#                                  [--same-host | --separate-domain <domain-ref>]
#
#   <destination>  anything rsync accepts: /mnt/vault/kf, user@host:/srv/backups/kf
#   <label>        the name this destination is known by, recorded in the ledger. Not the
#                  destination itself — that can carry a username, and the ledger is readable
#                  by every read role in the system.
#   --separate-domain <domain-ref>
#                  attest that this destination is in the named physical failure domain, which
#                  must already be approved in ops.physical_failure_domain_evidence. Required
#                  for a LOCAL path to count as off-site: a path on this machine is the same
#                  host until somebody who knows the hardware says otherwise.
#   --same-host    record the copy as NOT off-site, deliberately.
#
# What `offsite` is recorded as, and why (ops.backup_copy.offsite_basis):
#
#   user@host:/path                        remote-host        off-site
#   anything + --separate-domain <ref>     attested-domain    off-site, and encryption evidence
#   /local/path                            local-unattested   NOT off-site
#   anything + --same-host                 same-host          NOT off-site
#
# Until 2026-09-23 every local path defaulted to off-site unless --same-host was remembered, so
# a second disk in the same chassis satisfied the readiness check built to catch exactly that.

set -euo pipefail

# DATABASE_URL_FILE where set, DATABASE_URL otherwise. A connection string is a credential;
# see scripts/lib/secret.sh for why the file is preferred and why its mode is checked.
# shellcheck source=lib/secret.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/secret.sh"
kf_resolve_database_url
kf_configure_postgres_client

USAGE='usage: backup-offsite.sh <backup-directory> <destination> <label> [--same-host | --separate-domain <domain-ref>]'
BACKUP="${1:?$USAGE}"
DESTINATION="${2:?$USAGE}"
LABEL="${3:?$USAGE}"
shift 3
: "${PRESERVATION_TRUST_STORE_DIR:?set PRESERVATION_TRUST_STORE_DIR to the historical public-key directory}"

SAME_HOST=false
FAILURE_DOMAIN=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --same-host) SAME_HOST=true; shift ;;
    --separate-domain)
      FAILURE_DOMAIN="${2:?--separate-domain needs the approved domain_ref it attests}"
      shift 2
      ;;
    *) echo "$USAGE" >&2; exit 64 ;;
  esac
done
if [ "$SAME_HOST" = true ] && [ -n "$FAILURE_DOMAIN" ]; then
  echo "--same-host and --separate-domain contradict each other" >&2
  exit 64
fi

case "$DESTINATION" in
  *:*) REMOTE=true ;;
  *) REMOTE=false ;;
esac

if [ "$SAME_HOST" = true ]; then
  OFFSITE=false; BASIS=same-host
elif [ -n "$FAILURE_DOMAIN" ]; then
  OFFSITE=true; BASIS=attested-domain
elif [ "$REMOTE" = true ]; then
  OFFSITE=true; BASIS=remote-host
else
  OFFSITE=false; BASIS=local-unattested
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCATION="$(cd "$BACKUP" && pwd)"
NAME="$(basename "$LOCATION")"
CIPHERTEXT="$(dirname "$LOCATION")/$NAME.tar.gpg"

echo "==> checking the source before copying it"
# A corrupt source copied faithfully is a corrupt backup in two places. SHA256SUMS remains a
# compatibility check, but the signed root manifest is the authority for restore-critical
# sidecars and the closed file set.
node "$ROOT/packages/export/dist/cli.js" verify-backup "$LOCATION" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR"
( cd "$BACKUP" && sha256sum -c SHA256SUMS --quiet )
SOURCE_MANIFEST_DIGEST="$(sha256sum "$LOCATION/backup.manifest.json" | cut -d' ' -f1)"

if [ ! -f "$CIPHERTEXT" ] || [ -L "$CIPHERTEXT" ]; then
  echo "refusing to copy: $CIPHERTEXT is not a regular file" >&2
  echo "backup.sh writes it; a backup without one was taken before encryption and stays local" >&2
  exit 1
fi
# Measured, not assumed: an OpenPGP message encrypted to a public key begins with a
# public-key-encrypted session key packet (tag 1). Old-format headers 0x84-0x87, new-format
# 0xc1. A plaintext tarball renamed to .tar.gpg starts with neither and is refused here, before
# a single byte of it leaves.
FIRST_BYTE="$(od -An -tx1 -N1 -- "$CIPHERTEXT" | tr -d ' \n')"
case "$FIRST_BYTE" in
  84|85|86|87|c1) ;;
  *)
    echo "refusing to copy: $CIPHERTEXT does not begin with an OpenPGP public-key-encrypted packet" >&2
    exit 1
    ;;
esac
CIPHERTEXT_DIGEST="$(sha256sum -- "$CIPHERTEXT" | cut -d' ' -f1)"

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

if [ -n "$FAILURE_DOMAIN" ]; then
  echo "==> checking the attested failure domain is approved"
  # Checked before copying, so a typo in the domain fails in seconds rather than after a
  # two-hour transfer. The foreign key would refuse it at insert time anyway.
  DOMAIN_CURRENT="$("$KF_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -v domain="$FAILURE_DOMAIN" <<'SQL'
select count(*) from ops.physical_failure_domain_evidence
 where domain_ref = :'domain' and (valid_until is null or valid_until > now());
SQL
)"
  if [ "$DOMAIN_CURRENT" != 1 ]; then
    echo "refusing to attest: $FAILURE_DOMAIN has no current approval in ops.physical_failure_domain_evidence" >&2
    exit 1
  fi
fi

echo "==> copying the encrypted archive to $DESTINATION"
# --partial off by omission: a half-transferred file should not be left looking like a backup.
# rsync writes to a temporary name and renames on completion, and --fsync flushes each file.
rsync --checksum --times --fsync -- "$CIPHERTEXT" "$DESTINATION/$NAME.tar.gpg"

echo "==> verifying at the destination"
# Re-measured THERE, not here. Measuring the source again would prove only that the source is
# still fine, which was never the question.
if [ "$REMOTE" = true ]; then
  REMOTE_HOST="${DESTINATION%%:*}"
  REMOTE_PATH="${DESTINATION#*:}"
  printf -v REMOTE_FILE_QUOTED '%q' "$REMOTE_PATH/$NAME.tar.gpg"
  printf -v REMOTE_DIRECTORY_QUOTED '%q' "$REMOTE_PATH"
  DESTINATION_DIGEST="$(ssh "$REMOTE_HOST" "sha256sum -- $REMOTE_FILE_QUOTED" | cut -d' ' -f1)"
  ssh "$REMOTE_HOST" "sync -f -- $REMOTE_DIRECTORY_QUOTED"
else
  DESTINATION_DIGEST="$(sha256sum -- "$DESTINATION/$NAME.tar.gpg" | cut -d' ' -f1)"
  sync -f -- "$DESTINATION/$NAME.tar.gpg"
fi

if [ "$DESTINATION_DIGEST" != "$CIPHERTEXT_DIGEST" ]; then
  echo "the copy at $DESTINATION does not match the encrypted archive that was sent" >&2
  exit 1
fi

echo "==> recording the copy ($BASIS)"
"$KF_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -v run="$RUN_ID" -v label="$LABEL" -v offsite="$OFFSITE" -v digest="$RUN_MANIFEST_DIGEST" \
  -v basis="$BASIS" -v domain="$FAILURE_DOMAIN" -v ciphertext="$DESTINATION_DIGEST" <<'SQL'
insert into ops.backup_copy
  (backup_run_id, destination_label, offsite, manifest_digest,
   offsite_basis, failure_domain_ref, ciphertext_sha256)
values (:'run'::uuid, :'label', :'offsite'::boolean, :'digest',
        :'basis', nullif(:'domain', ''), :'ciphertext')
-- Re-copying the same backup to the same destination is a repeat of an event that already
-- happened, not a new one. The ciphertext is unchanged by definition; if it were not, the
-- verification above would have failed before reaching here.
on conflict (backup_run_id, destination_label) do nothing;
SQL

if [ -n "$FAILURE_DOMAIN" ]; then
  echo "==> recording encryption evidence for the attested copy"
  # Written from what this run measured — the ciphertext digest at the destination, and the
  # attested domain — rather than typed by an operator afterwards. `approved_by` and the
  # validity window are the domain approval's: the human judgement this evidence rests on is
  # that the domain is separate, and a person made it. The script contributes only facts it
  # observed, which is all it can honestly contribute.
  "$KF_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -v run="$RUN_ID" -v label="$LABEL" -v domain="$FAILURE_DOMAIN" \
    -v ciphertext="$DESTINATION_DIGEST" <<'SQL'
insert into ops.encrypted_backup_evidence
  (backup_copy_id, failure_domain_ref, evidence_ref, encrypted, separate_from_primary,
   approved_by, approved_at, valid_until)
select c.id, d.domain_ref,
       'kf-backup-offsite:v1:copy=' || c.id || ':ciphertext-sha256=' || c.ciphertext_sha256,
       true, true, d.approved_by, d.approved_at, d.valid_until
  from ops.backup_copy c
  join ops.physical_failure_domain_evidence d on d.domain_ref = c.failure_domain_ref
 where c.backup_run_id = :'run'::uuid
   and c.destination_label = :'label'
   and c.failure_domain_ref = :'domain'
   and c.ciphertext_sha256 = :'ciphertext'
on conflict (backup_copy_id) do nothing;
SQL
fi

echo "==> copied and verified: $LABEL ($BASIS)"
case "$BASIS" in
  same-host)
    cat >&2 <<'EOF'

Recorded as SAME HOST. Readiness will continue to report this backup degraded, because a
copy on the same machine does not survive losing the machine. That is not a bug in the check.
EOF
    ;;
  local-unattested)
    cat >&2 <<'EOF'

Recorded as NOT off-site: a local path is this host until somebody attests otherwise. If the
destination really is a separate device or machine, approve its failure domain in
ops.physical_failure_domain_evidence and re-run with --separate-domain <domain-ref>.
EOF
    ;;
  remote-host)
    cat >&2 <<'EOF'

Recorded as off-site (another host). No encryption evidence was recorded, because no approved
failure domain was named: re-run with --separate-domain <domain-ref> to record it.
EOF
    ;;
esac
