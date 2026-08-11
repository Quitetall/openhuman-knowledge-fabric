# Retention

## The horizon is unbounded, and that is not a placeholder

ISO 13485 §4.2.5 requires records to be retained for at least the lifetime of the device as
the organisation defines it. The WP1–10 closeout recorded the OH-EEG-1 device lifetime as
**undefined**. Until a lifetime is defined and approved, the retention obligation has no end
date, so records created today must remain readable indefinitely.

That single fact decides the architecture of this gate. It is why the durable artefact is
plain canonical text and not a database.

## What is actually the record

| Layer                                                 | Role                                    | Survives to                                     |
| ----------------------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| `export/` — RFC 8785 canonical JSON + `manifest.json` | **The institutional record**            | Anything that can read text and compute SHA-256 |
| PostgreSQL                                            | The operational engine over that record | One major-version support window at a time      |
| Object store                                          | Artifact bytes                          | As long as the bucket and its digests agree     |
| `dump.pgcustom`                                       | Fast operational restore                | A compatible PostgreSQL major version           |

A 2026 `PGDATA` directory will not mount on a 2045 server, and major-version migration is
mandatory every few years in between. Treating the database as the record would mean betting
an unbounded obligation on an artefact with a support horizon measured in years.

The export makes the engine replaceable rather than load-bearing. That claim is checked, not
asserted: `tests/round-trip/export.test.ts` exports a populated database, imports into an
empty one, re-exports, and compares every file byte for byte.

## Retention classes

Declared in `registry.retention_class` (seeded from `ontology/meta.yaml`). The class named
`device_lifetime` has `years = null` deliberately — a null there means "no end date has been
established", not "keep for zero years". Nothing in the system deletes on the basis of a null.

Retention holds (`core.retention_hold`) freeze a record against any disposal regardless of
class. There is no disposal path implemented, and there will not be one until a lifetime is
defined and approved through change control.

## What is deliberately not retained here

- **PHI.** Never enters this system, in any form, at any stage.
- **Bank details, tax identifiers, payroll.** Restricted HR/finance only; referenced, never
  copied.
- **Vendor datasheets.** Third-party copyright: referenced by document number, revision and
  digest. The licensed copy is filed offline.
- **Artifact bytes.** In the object store, not in PostgreSQL. The export carries the index and
  digests that prove the two still agree — see [backup and restore](../backup-and-restore/).

## Append-only, not immutable-by-convention

`core.action`, `core.audit_event`, `core.audit_checkpoint`, `core.approval`, `core.snapshot`
and `content.artifact_version` refuse UPDATE, DELETE and TRUNCATE by trigger — enforced
against the table owner, not only against the application role. A correction is a new record
that supersedes an old one; it is never an edit.
