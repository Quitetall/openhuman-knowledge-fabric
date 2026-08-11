# Backup and restore

**A backup is not valid until it has been restored.** Everything below follows from that.

## Take a backup

    DATABASE_URL=postgres://... scripts/backup.sh backups/2026-08-11

Produces:

| File            | What it is                       | Why both                                                              |
| --------------- | -------------------------------- | --------------------------------------------------------------------- |
| `dump.pgcustom` | `pg_restore` input               | Fast and exact, readable only by a compatible PostgreSQL              |
| `export/`       | Canonical JSON + `manifest.json` | Readable by anything that reads text — see [retention](../retention/) |
| `schema.sql`    | Schema alone                     | Readable without restoring                                            |
| `roles.sql`     | Cluster roles                    | `pg_dump` does not contain them, but the RLS policies name them       |
| `SHA256SUMS`    | Digests of everything above      | Bit rot and truncated copies are detectable without a database        |

Neither the dump nor the export substitutes for the other. The dump answers "get us running
again this afternoon". The export answers "can this still be read in 2045".

## Restore, and prove it

    scripts/restore-verify.sh backups/2026-08-11 postgres://...target

The script:

1. checks `SHA256SUMS`, and the export against its own manifest — **before** writing anything;
2. **refuses** a target that already has a `core` schema;
3. loads cluster roles, then fails closed if any role the schema depends on is still missing;
4. `pg_restore --exit-on-error` (a restore that "succeeds" having skipped objects is worse
   than one that fails — it produces a database that looks restored);
5. re-exports from the restored database and diffs **every file byte for byte** against the
   export taken at backup time;
6. verifies the audit ledger, if a checkpoint key is available — and says out loud when it is
   not, rather than passing quietly.

Exercised end to end by `tests/backup-restore/drill.test.ts`, which runs these scripts —
not a reimplementation of them — against real containers. A test that re-derived what
`backup.sh` does would pass while `backup.sh` was broken.

## The object store is not in here

`dump.pgcustom` and `export/` hold artifact **identity and digests**. The bytes live in the
object store. Back up that bucket on the same schedule, or a restore returns a catalogue of
things you no longer have.

`verifyRecordedVersion` re-reads each stored object and recomputes its digest — run it across
the vault after any restore. It is the only thing that can answer whether the two halves still
agree; no amount of database integrity can.

## Audit ledger verification

    CHECKPOINT_PUBLIC_KEY_PATH=... DATABASE_URL=... node apps/checkpoint/dist/main.js --verify

Recomputes the hash chain from genesis, rebuilds each checkpoint's Merkle root from the events
actually present, and verifies each signature. Exits non-zero on any finding — a verification
that reports problems and exits 0 would be recorded by a scheduler as a clean audit.

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

Not yet operationalised — cron, offsite copies, PITR and the retention of the backups
themselves are Gate 8. What exists today is the mechanism and the proof that it works.
