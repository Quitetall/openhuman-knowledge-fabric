# Where the bytes are is a set of locations, each verifiable on its own

**Status:** accepted — implemented 2026-09-02; builds on ADR 0004, ADR 0006
**Date raised:** 2026-09-01
**Date decided:** 2026-09-02
**Decision owner:** technical authority
**Scope:** how an artifact version's bytes are located, copied, verified and served; what a
second store is; what is deliberately not written

## The problem, measured

`content.artifact_version` carried one address: `storage_uri` + `storage_version`, the working
object store. There was no row in which a second copy could exist, so none could be recorded,
verified, or served when the first was gone. ADR 0004's commissioning criteria want a restore
that has been drilled; the operations ledger records database backups (`ops.backup_copy`) but
nothing about the artifact bytes those backups point at. A lost bucket would have been a lost
evidence vault with a complete-looking ledger.

## Decision

**Two tables.** `content.artifact_store` declares the places bytes may live — an id, a kind
(`object_store` for anything on the S3 wire, including Google Cloud Storage through its S3
interoperability endpoint; `memory` for tests), a label that is a name and never a URI with
credentials, and whether it is writable. Credentials stay instance configuration.
`content.artifact_location` is one row per (version, store, role): the address, the store's
immutable object version where it has one, who recorded it and by which act, and the last
verification — `verified_at`, `verified_sha256` or `verification_failure`, and the verifying
act. Roles are `working` (exactly one per version), `hot_cache`, `durable_copy`,
`evidence_copy`, and `public_copy`.

**The old columns are the working row, read through the old names.** `artifact_version` is
append-only, so `storage_uri`/`storage_version` are written once; a trigger records the same
address as the version's `working` location in the same statement, and a second trigger
refuses a working location that disagrees with the columns. Fourteen readers of the columns
keep working unchanged, and the ledger is complete for every version that ever had an
address. Locations are append-only: only the verification of a location may change. A lost
copy is recorded as a failed verification, never by deleting the row.

**Replication verifies on arrival.** `replicateVersion` reads the working bytes, refuses to
copy anything that does not hash to the version's sha256, writes into the target store with
create-only semantics (an object already at the key is kept and re-hashed, never
overwritten), records the location, and verifies what landed. The typed action
`replicate_artifact_version` targets the artifact and names the version, store and role;
`verify_artifact_location` re-hashes one location and records the outcome either way,
because a failed verification is the finding the ledger exists to hold.

**Reads degrade, they do not fail silently.** `readVersionBytes` tries the working copy, then
every location whose last verification matched the version's digest, and hashes what it gets
before serving it. Losing the working store is a degraded read from the durable copy; a
tampered durable copy is never served.

**`public_copy` exists and nothing writes it.** The schema allows the role so that a
publication act has a row to make. Replication refuses it, and no other code path produces
it: publishing is a boundary crossing (ADR 0006) with its own act, deferred with the
publication boundary.

**The second store is configuration.** `S3_DURABLE_*` declares it; the app registers it as
`durable` beside `working`. GCS via S3 interop is the same client with a different endpoint.

## What this does not decide

- **Scheduling.** Replication and re-verification are acts; nothing yet runs them on a
  cadence. The checkpoint runner is the obvious host and is not wired.
- **Routing every read through locations.** The two byte routes (`/documents/:id/source` and
  the projection download) now fall back to `readVersionBytes` when the working copy is
  missing or corrupt, and log that they served from a copy (2026-09-02). The checkpoint
  runner and the ingest path still address the working store directly.
- **Evidence and public copies' receipts.** `evidence_copy` records the digest an auditor was
  handed; what the auditor signs is outside the fabric.
- **Orphaned objects.** A store cannot join the database transaction, so a replication whose
  row fails after the put leaves bytes with no location. Create-only writes make the next
  replication find, re-hash and record them; a sweep for objects with no row is not built.
- **Deleting bytes.** No action removes an object from a store. Retention (ADR 0004) will
  need one, with its own act.

## How this is held

`tests/database/artifact-locations.test.ts`, against a real database with two in-memory
stores: recording a version creates its working location by trigger, equal to the columns;
a disagreeing working location, a delete, and a non-verification update are refused;
dispatched replication and verification leave one version with two locations both verified
to the same digest, and refuse the wrong target artifact; with the working store gone the
durable copy serves the bytes; a tampered durable copy is a recorded verification failure and
is then not served; and `public_copy` cannot be produced by replication. The closed
preservation inventory requires both tables to be exported, and they are.
