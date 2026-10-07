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
set +x
set +v
ulimit -c 0

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
# shellcheck source=lib/preservation-secrets.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/preservation-secrets.sh"
kf_prepare_preservation_signing_key

# A deployed host is one whose unit declares a deployment profile; the shipped kf-backup.service
# sets KF_DEPLOYMENT_PROFILE=dogfood. There, two things that are optional on a workstation are
# not: the checkpoint public keys (without them a restored audit log cannot be checked against
# its signatures, which the restore drill then records as partial every month), and the
# recipient key everything leaving this host is encrypted to.
KF_DEPLOYED=false
case "${KF_DEPLOYMENT_PROFILE:-}" in
  ''|development) ;;
  *) KF_DEPLOYED=true ;;
esac
if [ "$KF_DEPLOYED" = true ]; then
  : "${CHECKPOINT_PUBLIC_KEY_DIR:?set CHECKPOINT_PUBLIC_KEY_DIR: a deployed backup must carry the checkpoint public keys}"
  : "${KF_BACKUP_RECIPIENT_FILE:?set KF_BACKUP_RECIPIENT_FILE to the OpenPGP public key backups are encrypted to}"
fi

# Encryption to a PUBLIC key. The matching private key is held off this host by whoever runs
# recovery; this host can produce ciphertext and cannot read it back, so a stolen off-site copy
# and a compromised backup job are both just bytes. A recipient file that carries a secret key
# is refused outright rather than used: putting it here would undo the whole arrangement.
ENCRYPTION_KEYIDS=""
GPG_HOME=""
if [ -n "${KF_BACKUP_RECIPIENT_FILE:-}" ]; then
  if [ ! -f "$KF_BACKUP_RECIPIENT_FILE" ] || [ -L "$KF_BACKUP_RECIPIENT_FILE" ]; then
    echo "KF_BACKUP_RECIPIENT_FILE must be a regular file, not a link: $KF_BACKUP_RECIPIENT_FILE" >&2
    exit 1
  fi
  if grep -q 'PRIVATE KEY BLOCK' "$KF_BACKUP_RECIPIENT_FILE"; then
    echo "refusing KF_BACKUP_RECIPIENT_FILE: it contains a private key, which must not be on this host" >&2
    exit 1
  fi
  command -v gpg >/dev/null 2>&1 || { echo "gpg is required to encrypt backups" >&2; exit 1; }
  # A throwaway keyring: the recipient is named by file, never imported into anything that
  # outlives this run, so the host holds no trust decisions an attacker could edit.
  GPG_HOME="$(mktemp -d)"
  chmod 700 "$GPG_HOME"
  kf_at_exit 'rm -rf "$GPG_HOME"'
  RECIPIENT_LISTING="$(gpg --batch --no-tty --homedir "$GPG_HOME" --with-colons \
    --show-keys "$KF_BACKUP_RECIPIENT_FILE" 2>/dev/null)"
  if printf '%s\n' "$RECIPIENT_LISTING" | grep -Eq '^(sec|ssb):'; then
    echo "refusing KF_BACKUP_RECIPIENT_FILE: it contains a private key, which must not be on this host" >&2
    exit 1
  fi
  # Key ids able to encrypt (capability field contains `e`). The archive is later checked to
  # name one of these, so "encrypted" is measured rather than inferred from an exit code.
  ENCRYPTION_KEYIDS="$(printf '%s\n' "$RECIPIENT_LISTING" \
    | awk -F: '($1 == "pub" || $1 == "sub") && $12 ~ /e/ { print $5 }')"
  if [ -z "$ENCRYPTION_KEYIDS" ]; then
    echo "KF_BACKUP_RECIPIENT_FILE holds no key capable of encryption" >&2
    exit 1
  fi
fi

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

echo "==> retention: pruning local backups already safe elsewhere"
# Local copies are plaintext, and until 2026-09-23 they were never removed: every night added
# one more complete copy of every record to the database host's disk. Now the newest
# KF_BACKUP_RETAIN_LOCAL (default 7) are kept, and an older one is removed only once the ledger
# records an off-site copy of it — a backup whose only copy is here is never pruned, however
# old. When the off-site path is broken this keeps everything, and the free-space check below
# then fails loudly instead of the disk failing quietly.
RETAIN_LOCAL="${KF_BACKUP_RETAIN_LOCAL:-7}"
if [[ ! "$RETAIN_LOCAL" =~ ^[1-9][0-9]*$ ]]; then
  echo "KF_BACKUP_RETAIN_LOCAL must be a positive integer" >&2
  exit 1
fi
PRUNABLE="$("$KF_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA \
  -v parent="$DEST_PARENT/" -v keep="$RETAIN_LOCAL" <<'SQL'
select r.location
  from (select b.id, b.location,
               row_number() over (order by b.finished_at desc, b.id desc) as newest
          from ops.backup_run b
         where starts_with(b.location, :'parent')) r
 where r.newest > :'keep'::integer
   and exists (select 1 from ops.backup_copy c where c.backup_run_id = r.id and c.offsite)
 order by r.location;
SQL
)"
while IFS= read -r PRUNE; do
  [ -n "$PRUNE" ] || continue
  PRUNE_NAME="$(basename -- "$PRUNE")"
  # Only a plain child of this backup root, by a name backup.sh could have produced. The
  # ledger is data; it does not get to name an arbitrary path for `rm -rf`.
  if [ "$(dirname -- "$PRUNE")" != "$DEST_PARENT" ] ||
     [[ ! "$PRUNE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "retention: refusing to prune unexpected path $PRUNE" >&2
    continue
  fi
  if [ -d "$PRUNE" ] && [ ! -L "$PRUNE" ]; then
    rm -rf -- "$PRUNE"
    echo "retention: pruned $PRUNE"
  fi
  rm -f -- "$PRUNE.tar.gpg"
done <<< "$PRUNABLE"

echo "==> checking free space"
# Twice the previous backup (the plaintext bundle and its ciphertext), plus a reserve. The
# first backup has no predecessor and uses the database size, which over-estimates a
# compressed dump — the safe direction to be wrong in.
ESTIMATE="$("$KF_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA <<'SQL'
select coalesce((select byte_size from ops.backup_run
                  where database_name = current_database()
                  order by finished_at desc, id desc limit 1),
                pg_database_size(current_database()));
SQL
)"
RESERVE="${KF_BACKUP_FREE_SPACE_RESERVE_BYTES:-1073741824}"
if [[ ! "$ESTIMATE" =~ ^[0-9]+$ ]] || [[ ! "$RESERVE" =~ ^[0-9]+$ ]]; then
  echo "could not estimate the space this backup needs" >&2
  exit 1
fi
NEEDED=$(( 2 * ESTIMATE + RESERVE ))
AVAILABLE="$(df --output=avail -B1 -- "$DEST_PARENT" | tail -n 1 | tr -d ' ')"
if [[ ! "$AVAILABLE" =~ ^[0-9]+$ ]] || [ "$AVAILABLE" -lt "$NEEDED" ]; then
  echo "refusing to start: $DEST_PARENT has ${AVAILABLE:-unknown} bytes free, this backup needs about $NEEDED" >&2
  echo "a backup that fills the disk half-way fails, and takes the database's disk with it if shared" >&2
  exit 1
fi

# Build beside final name. All bytes and metadata are flushed before one same-filesystem rename
# publishes complete tree. A crash or failed command leaves no directory that looks finished.
STAGING_DEST="$(mktemp -d "$DEST_PARENT/.${DEST_NAME}.partial.XXXXXX")"
DEST="$STAGING_DEST"
CIPHERTEXT_STAGING=""
backup_staging_cleanup() {
  if [ -n "${STAGING_DEST:-}" ] && [ -d "$STAGING_DEST" ]; then
    rm -rf -- "$STAGING_DEST"
  fi
  if [ -n "${CIPHERTEXT_STAGING:-}" ]; then
    rm -f -- "$CIPHERTEXT_STAGING"
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
#
# The context seal key's ROW is excluded, not just unreadable: seals last one transaction, so a
# restored database needs a key rather than this one, and the first seal after a restore makes a
# fresh one (20260923000100). Kept out, the key is not readable by whoever holds a dump. The
# same holds for person attestations: each is a sixty-second proof of presence, and a restored
# host must mint its own rather than inherit any (20260924001000, 20260925130000).
#
# Row security is enabled rather than bypassed: the backup login is kf_backup, which row security
# binds, and it reads each table through a policy granting it the whole table (20260925130000).
# Without the flag pg_dump refuses every such table; with it and a table lacking that policy, the
# dump would be silently short — tests/backup-restore/drill.test.ts refuses both.
#
# Transient observations (§64B, ADR 0029) are excluded the same way: they expire after 90 days,
# and a dump retained longer would keep them past it (KF-SAS-RQ-220). One line per table declared
# under `transientTables` in docs/architecture/master-record-boundary.json;
# tests/conformance/transient-observations.test.ts refuses a declared table missing here.
"$KF_PG_DUMP" --format=custom --no-owner --no-privileges --snapshot="$SNAPSHOT_ID" \
  --enable-row-security \
  --exclude-table-data=core.context_seal_key \
  --exclude-table-data=core.principal_attestation \
  --exclude-table-data=search.recorded_query \
  --exclude-table-data=search.demand_contribution \
  --exclude-table-data=search.asker_key \
  --exclude-table-data=retrieval.disclosure \
  --exclude-table-data=search.context_disclosure \
  --exclude-table-data=search.identification_refusal \
  --exclude-table-data=content.master_record_currency \
  --exclude-table-data=content.master_record_input_write \
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
kf_preservation_database_child "${DATABASE_URL_FILE:-}" \
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
# pg_dumpall ignores the database component of --dbname. Select the already
# admitted database explicitly instead of requiring CONNECT to postgres or
# template1, which the backup principal need not hold.
BACKUP_DATABASE="$("$KF_PSQL" "$DATABASE_URL" --no-psqlrc --tuples-only --no-align --quiet \
  --set ON_ERROR_STOP=1 --command='select current_database()')"
if [ -z "$BACKUP_DATABASE" ]; then
  echo "refusing to dump roles without the admitted database identity" >&2
  exit 1
fi
"$KF_PG_DUMPALL" --roles-only --no-role-passwords --file="$DEST/roles.sql" \
  --dbname="$DATABASE_URL" --database="$BACKUP_DATABASE"

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
kf_preservation_signing_child node "$ROOT/packages/export/dist/cli.js" sign-backup "$DEST" \
  --signing-key "$PRESERVATION_SIGNING_KEY_PATH" \
  --key-id "$PRESERVATION_SIGNING_KEY_ID" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR"

echo "==> authenticating complete backup bundle through external trust store"
node "$ROOT/packages/export/dist/cli.js" verify-backup "$DEST" \
  --trust-store "$PRESERVATION_TRUST_STORE_DIR"

FINAL_CIPHERTEXT="$FINAL_DEST.tar.gpg"
if [ -n "$ENCRYPTION_KEYIDS" ]; then
  echo "==> encrypting the verified bundle for off-host copies"
  # From the staging tree that was just authenticated, so the ciphertext holds exactly the
  # bytes the signature covers. Archive root is the bundle's contents, not a directory name:
  # whoever restores chooses where it lands.
  if [ -e "$FINAL_CIPHERTEXT" ]; then
    echo "refusing to overwrite existing encrypted archive: $FINAL_CIPHERTEXT" >&2
    exit 1
  fi
  CIPHERTEXT_STAGING="$(mktemp "$DEST_PARENT/.${DEST_NAME}.tar.gpg.partial.XXXXXX")"
  tar --create --file=- --directory="$STAGING_DEST" --sort=name --numeric-owner . \
    | gpg --batch --no-tty --quiet --homedir "$GPG_HOME" --no-options --trust-model always \
        --recipient-file "$KF_BACKUP_RECIPIENT_FILE" --encrypt --yes --output "$CIPHERTEXT_STAGING"
  # What was produced, read back: the packets must be a public-key-encrypted session key for a
  # configured recipient followed by integrity-protected data. `--list-packets` exits nonzero
  # here by design — this host has no secret key — so its output is inspected, not its status.
  PACKETS="$(gpg --batch --no-tty --homedir "$GPG_HOME" --list-packets "$CIPHERTEXT_STAGING" 2>/dev/null || true)"
  ENCRYPTED_TO=""
  while IFS= read -r KEYID; do
    [ -n "$KEYID" ] || continue
    if printf '%s\n' "$PACKETS" | grep -q ":pubkey enc packet: .* keyid $KEYID\$"; then
      ENCRYPTED_TO="$KEYID"
    fi
  done <<< "$ENCRYPTION_KEYIDS"
  if [ -z "$ENCRYPTED_TO" ] ||
     ! printf '%s\n' "$PACKETS" | grep -Eq '^:(encrypted data packet|aead encrypted packet):'; then
    echo "encryption produced no public-key-encrypted archive for the configured recipient" >&2
    exit 1
  fi
  sync -f "$CIPHERTEXT_STAGING"
fi

# The off-site copier reads both: it re-verifies this bundle before it sends anything, then ships
# the ciphertext — as kf-offsite, through the kf-archive group the setgid parent directory gives
# every entry here. mktemp made both owner-only and kf-backup.service runs with UMask=0077, so on
# the first host kf-offsite could not even enter the directory (KF-WAR-0001 rehearsal,
# 2026-10-07). Group read, never group write, never other.
chmod -R g+rX,g-w,o-rwx -- "$STAGING_DEST"
if [ -n "$CIPHERTEXT_STAGING" ]; then chmod 0640 -- "$CIPHERTEXT_STAGING"; fi

echo "==> durably publishing complete backup"
# GNU sync -f issues syncfs(2) for filesystem containing staging tree: payload data, signed
# sidecars, nested directory entries, and metadata are durable before rename. Parent flush then
# makes rename itself durable before ledger records success.
sync -f "$STAGING_DEST"
# Ciphertext first: the off-site job copies the newest DIRECTORY's archive, so the archive must
# already exist when the directory appears.
if [ -n "$CIPHERTEXT_STAGING" ]; then
  mv -- "$CIPHERTEXT_STAGING" "$FINAL_CIPHERTEXT"
  CIPHERTEXT_STAGING=""
fi
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

if [ -n "$ENCRYPTION_KEYIDS" ]; then
  echo "encrypted archive for off-host copies: $FINAL_CIPHERTEXT (recipient key $ENCRYPTED_TO)"
else
  echo "NOT ENCRYPTED: KF_BACKUP_RECIPIENT_FILE is unset, so backup-offsite.sh will refuse to copy this backup" >&2
fi

cat <<'EOF'

This backup is on the same host as the database. Until a copy reaches somewhere else,
readiness reports it degraded — a backup beside the thing it backs up survives a dropped
table and not a lost host.

    scripts/backup-offsite.sh <this directory> <destination> <label> [--separate-domain <ref>]
EOF
