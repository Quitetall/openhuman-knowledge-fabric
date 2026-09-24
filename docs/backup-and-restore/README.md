# Backup and restore

**A backup is not valid until it has been restored.** Everything below follows from that.

## Take a backup

    DATABASE_URL=postgres://... scripts/backup.sh backups/2026-08-11

Produces:

| File                             | What it is                         | Why both                                                              |
| -------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `dump.pgcustom`                  | `pg_restore` input                 | Fast and exact, readable only by a compatible PostgreSQL              |
| `export/`                        | Canonical JSON + signed manifest   | Readable by anything that reads text — see [retention](../retention/) |
| `schema.sql`                     | Schema alone                       | Readable without restoring                                            |
| `roles.sql`                      | Cluster roles                      | `pg_dump` does not contain them, but the RLS policies name them       |
| `SHA256SUMS`                     | Compatibility digests              | Conventional bit-rot check; not an authenticity claim                 |
| `backup.manifest.json`           | Closed file set, sizes and SHA-256 | Commits to every file above, including `SHA256SUMS`                   |
| `backup.manifest.signature.json` | Ed25519 root-manifest signature    | Authenticates restore inputs against external historical trust        |

**What a backup does not carry.** Transient observations (§64B, ADR 0029) — recorded queries,
their pseudonym key, the per-person demand contributions and retrieval-trace digests — expire
after 90 days, and a backup retained longer than that would keep them past their window. Their
**data** is therefore left out of the dump (`--exclude-table-data`, one per table declared under
`transientTables` in `docs/architecture/master-record-boundary.json`), and they are excluded from
the canonical export. The tables themselves are restored empty. A restore that finds rows in them
has found a defect, not a success. The same holds for the context seal key and for person
attestations (sixty-second proofs of presence): a restored host mints its own.

**Who takes it.** A deployed host runs `backup.sh` as a login holding `kf_backup` and nothing
else, and row-level security binds that login. So the dump runs with `--enable-row-security`,
and every table whose rows it carries has a policy letting `kf_backup` read the whole table;
`kf_backup` reads the derived search and retrieval tables the same way, because nothing in the
restore path rebuilds them. The tables whose rows are left out are granted `MAINTAIN` — enough
for `pg_dump` to lock them, not to read them — so dropping an exclusion from the script makes the
dump fail rather than keep what it must not. Until 2026-09-24 none of this held: `kf_backup` could
not reach `search` or `retrieval`, could not lock thirteen tables or read any sequence, and had no
policy on `core.object`, so a backup as that login failed outright, and an export as it would have
held no records. The drill ran as the superuser and passed. It now also runs the whole script as
a `kf_backup` login (`tests/backup-restore/drill.test.ts`, "backup as the backup login").

Neither the dump nor the export substitutes for the other. The dump answers "get us running
again this afternoon". The export answers "can this still be read in 2045". The backup
coordinator opens one `REPEATABLE READ READ ONLY` transaction, exports one PostgreSQL snapshot,
and holds it while the custom dump, schema dump, and canonical export import the same strict
token. A row committed after the snapshot is absent from all three, rather than appearing in
whichever command happened to run last.

The root manifest has no recursive self-entry: it lists every content file, then a separate
signature sidecar signs `UTF8(JCS(manifest) || 0x0A)` — canonical JSON plus one LF, exactly as
stored in `backup.manifest.json`. `SHA256SUMS` therefore remains usable
by ordinary tools while the signed root authenticates the sums themselves. The signing key stays
external. Verification uses the append-only multi-key `PRESERVATION_TRUST_STORE_DIR`; a backup
cannot nominate its own trust root. The root manifest also repeats the exact authenticated inner
`database_snapshot_sha256`, binding operational bundle to canonical database-row identity.

### Encryption, retention and space

Every backup is also written as `<backup>.tar.gpg` beside its directory: the signed bundle,
tarred and encrypted with `gpg` to the OpenPGP **public** key in `KF_BACKUP_RECIPIENT_FILE`.
That archive is the only thing `backup-offsite.sh` ships; plaintext never leaves the host. The
matching private key is held by whoever performs recovery and is not on the database host —
`backup.sh` refuses a recipient file containing one. After encrypting, the script reads the
archive's packets back and requires a public-key-encrypted session key for a configured
recipient, so "encrypted" is measured, not assumed from an exit code.

On a deployed host (the unit sets `KF_DEPLOYMENT_PROFILE=dogfood`) the recipient and
`CHECKPOINT_PUBLIC_KEY_DIR` are **required**; without them the script stops before touching the
database. On a workstation both stay optional, and an unencrypted backup is reported as one the
off-site job will refuse.

Local copies are plaintext, so they are pruned: the newest `KF_BACKUP_RETAIN_LOCAL` (default 7)
are kept, and an older one is removed only once the ledger records an off-site copy of it. A
backup whose only copy is local is never pruned. Before taking a snapshot the script requires
free space of twice the previous backup plus `KF_BACKUP_FREE_SPACE_RESERVE_BYTES` (default
1 GiB), and refuses to start otherwise — a backup that fills the disk half-way fails anyway, and
takes anything sharing that disk with it.

Verify without database access:

```sh
node packages/export/dist/cli.js verify-backup backups/2026-08-11 \
  --trust-store /external/preservation-trust.d
```

Outer backup hashing and staging stream in fixed-size chunks, so dump size does not become Node
heap use. Current canonical-export semantic verifier remains in-memory and therefore fails closed
above 128 MiB per export file or 512 MiB total. Split/roll export sections or replace verifier with
streaming semantic parser before operating beyond those explicit limits; it never reads an
unbounded package.

## Restore, and prove it

    scripts/restore-verify.sh backups/2026-08-11 /run/kf/restore-target-url

`/run/kf/restore-target-url` must be an owner-only regular file containing the connection string.
An optional third argument is an owner-only production-ledger URL file. Connection strings are
never accepted directly as arguments: an inline password would already be visible in
`/proc/<pid>/cmdline` before the script could move it into `PGPASSFILE`.

The script:

1. authenticates signed root manifest, closed regular-file set, and every digest — **before**
   executing `roles.sql` or reading `dump.pgcustom`; recomputed `SHA256SUMS` cannot bypass this;
   exact verified bytes are streamed into a new mode-`0700` staging tree, and restore consumes
   only that tree, so swapping a source path after verification cannot change executed bytes;
2. checks compatibility sums and canonical export signature;
3. **refuses** a target that already has a `core` schema;
4. loads cluster roles, then fails closed if any role the schema depends on is still missing;
5. `pg_restore --exit-on-error` (a restore that "succeeds" having skipped objects is worse
   than one that fails — it produces a database that looks restored);
6. re-exports from the restored database and diffs **every file byte for byte** against the
   export taken at backup time. The re-export is signed with a key generated for the run, never
   the preservation key: the comparison excludes the signature sidecar, the only file a key id
   reaches, so that signature proves nothing and a restore needs no long-lived private key;
7. verifies the audit ledger against authenticated historical checkpoint keys;
8. invokes the object-store verifier `<request-file> <proof-output-file>` — the one the release
   ships (`apps/kf-storage/dist/verify-object-store.js`, reading `S3_*` and
   `S3_SECRET_ACCESS_KEY_FILE`), or an override named in `KF_OBJECT_STORE_VERIFY_PROGRAM` whose
   SHA-256 must match `KF_OBJECT_STORE_VERIFY_PROGRAM_SHA256` — with a request naming each stored
   object (`storage_uri`, `storage_version`) and nothing about its contents. The program answers
   with the `sha256` and `size_bytes` it measured by re-reading each object, and
   `scripts/lib/object-store-proof.mjs` checks that answer against the authenticated export: every
   requested object exactly once, every digest and size equal;
9. records separate database, checkpoint-trust, and object-store proof dimensions. Generic
   `verified` is legal only when all three pass. Missing proof records `partial` and exits nonzero.

The scheduled drill (`scripts/restore-drill.sh`, run by `kf-restore-drill.service`) does not
restore the local directory. It pulls the newest off-site `<backup>.tar.gpg` back, refuses it
unless its SHA-256 equals the ciphertext digest `backup-offsite.sh` recorded at the destination,
decrypts it with the recipient's private key (a sealed systemd credential delivered only to
`kf-restore-drill.service`, which runs as its own `kf-drill` uid — never the backup job's),
checks the decrypted root manifest against `ops.backup_run`, and runs the
steps above against a **throwaway cluster** it initialises for the run: Unix socket only, in a
0700 directory, on its own port, deleted on exit. The production cluster is never a restore
target. `ops.restore_drill.notes` records which copy was restored; `--allow-local-fallback`
restores the local original when the off-site copy is unavailable and says so there.

Exercised end to end by `tests/backup-restore/drill.test.ts`, which runs these scripts —
not a reimplementation of them — against real containers. A test that re-derived what
`backup.sh` does would pass while `backup.sh` was broken.

## An older export still imports

A canonical export is the record that outlives the engine, so `importExport` restores every
archive an earlier exporter signed, not only one cut by today's. Where a table changed shape
without an export format bump, the importer moves the archive's rows exactly as the migration
moved the live rows, keyed on what the archive carries rather than on a date:

- an audit event with no `link_format` is an untagged `kf-audit-link-v1` link, a document parse
  with no `digest_format` an untagged `kf-document-parse-v1` preimage, an act with no
  `agent_participation` one no agent took part in;
- a deliverable that names `deliverable_kind` and `definition_of_done` (before `20260925130100`)
  gets `definition_of_done` as its description and its one acceptance criterion, and both old
  values become its `work.deliverable_retired_attribute` row, stamped when the restore retired
  them. An archive that mixes the two shapes, or carries old rows and a retired-attributes section,
  was written by no exporter and is refused;
- a section added later without a format bump (`object-verifications`, `access-demand`,
  `deliverable-retired-attributes`, named in `packages/export/src/internal/section-eras.ts`) may be
  absent — file, manifest entry and count together — and the snapshot identity is recomputed over
  the sections the archive's exporter wrote. Any other missing section is still a truncated export
  and refused.

`tests/round-trip/deliverable-upconversion.test.ts` cuts an old-shape archive from a current one,
restores it, and holds the re-export byte-equal to the original.

## The object store is not in here

`dump.pgcustom` and `export/` hold artifact **identity and digests**. The bytes live in the
object store. Back up that bucket on the same schedule, or a restore returns a catalogue of
things you no longer have.

`verifyRecordedVersion` re-reads each stored object and recomputes its digest — run it across
the vault after any restore. It is the only thing that can answer whether the two halves still
agree; no amount of database integrity can.

The release ships the verifier (`apps/kf-storage/src/verify-object-store.ts`); the drill runs it
with `/etc/kf/drill.env` and a read-only key in `/etc/kf/drill/s3-secret-access-key`, and records
`kf-builtin-verifier:<bucket>` unless `KF_OBJECT_STORE_PROOF_REF` names other evidence. Until
2026-09-23 every host had to supply its own. A store it cannot speak to can still be served by
an override: point `KF_OBJECT_STORE_VERIFY_PROGRAM` at an absolute, root-owned, non-writable
executable and pin its reviewed digest in `KF_OBJECT_STORE_VERIFY_PROGRAM_SHA256` (a mismatch
refuses the restore outright) — it is the one verifier not covered by the release manifest.
Either way the verifier reads
the request file given as its first argument — one JSON object per line, `storage_uri` and
`storage_version` — re-reads each object from the store, and writes one line per object to the
second argument: the same two fields plus the `sha256` and `size_bytes` it measured. It is never
given the export, so it cannot pass by repeating the digests the export records; the comparison
happens in this repository's code. Until 2026-09-23 the adapter received the export and was
trusted on its exit code. KF stores proof digest and reference, never object-store credentials
or PHI bytes.

## Audit ledger verification

    CHECKPOINT_PUBLIC_KEY_DIR=... DATABASE_URL=... node apps/checkpoint/dist/main.js --verify

Recomputes the hash chain from genesis, rebuilds each checkpoint's Merkle root from the events
actually present, and verifies each signature. Exits non-zero on any finding — a verification
that reports problems and exits 0 would be recorded by a scheduler as a clean audit.

`kf-audit-verify.timer` runs exactly this daily against the live database, as its own
identity holding only public keys, and fails into `kf-alert@` on any finding. Until 2026-09-23
signatures were verified only inside the monthly restore drill.

The three checks are independent, which is the point: a tamperer who fixes the chain still
fails the root, and one who fixes both still cannot produce the signature.

| Finding          | Means                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `chain_broken`   | Digest links do not follow — an event was altered, deleted or inserted |
| `root_mismatch`  | Chain relinked over an edit; the signed tree disagrees                 |
| `missing_events` | A signed range holds fewer events than were signed — deletion          |
| `bad_signature`  | A checkpoint was not produced by the key it names                      |
| `unknown_key`    | No public key supplied — **unverifiable is not the same as valid**     |
| `gap`            | Events covered by no checkpoint at all                                 |

## Schedule

Repository supplies systemd units and timers for checkpoints, daily backup plus off-site copy,
daily audit-ledger verification (`kf-audit-verify.timer`), the daily object-store copy and
re-hash (`kf-storage.timer`), monthly restore drills and readiness checks; the full table is in
[`deploy/systemd/README.md`](../../deploy/systemd/README.md#scheduled-operations). Those files are
deployment inputs, not evidence that a host installed or successfully ran them. PITR, retention,
off-site destination, the alert receiver, recovery objectives, key custody and the object-store
verifier's credentials and routing (or, for a store the shipped verifier cannot speak to, a pinned
override program) still require named human/operator commissioning and substrate evidence. Until that evidence
exists, production preservation readiness remains unproven.
