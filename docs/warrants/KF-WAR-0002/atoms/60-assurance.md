---
schema: oh.war/atom/v1
warrant_uuid: 01a114df-fbc0-7b81-a04a-9c99fc062cab
role: assurance
jurisdiction: authored
order: 60
classification: internal
---

# Assurance

No registered gate covers integration work: the only one in `docs/gates/` qualifies a host. Each
obligation therefore names the checks that produce its evidence, and a candidate gate where one
would be worth registering. A candidate is a name, not a gate; it is not cited as one.

## Acceptance obligations

### OBL-001 — the object store starts on a clean machine and keeps every version
- **scope:** SAS §100.40, KF-SAS-RQ-161 (partial), KF-SAS-RQ-090.
- **checks:** `pnpm gate`; tests/database/object-store-versioning.test.ts and
  tests/deployment/object-store-init.test.ts once merged; `migrate-objects.mjs verify` on each
  live stack.
- **evidence:** a `docker compose up` log from a machine with no cached object-store image; the
  verify counts per stack, each equal to the count of versions the database records.
- **falsification:** the branch's own: remove the versioning enable and read-back from
  `init-buckets.sh` and 4 of 5 versioning tests must fail. Run it again after the merge, because a
  merge can drop a hunk silently.

### OBL-002 — one schema for the off-site copy's identity
- **scope:** KF-SAS-RQ-165 (partial), KF-SAS-RQ-095 (partial).
- **checks:** the extended export round trip, migration reversibility, and the three DB test files
  that failed on `host/offsite-tailnet`.
- **evidence:** `database/migrations/` holds exactly one migration recording the off-site object's
  version (Codex's `20261002000100`), and the drill pulls back the version it recorded.
- **falsification:** point a drill at a different key or a missing version; it must refuse by
  name (`object_location_mismatch`, `version_not_found`).

### OBL-003 — the engine KF is tested against is the engine KF runs
- **scope:** KF-SAS-RQ-213 and RQ-218 (validation), SAS §100.21.
- **checks:** `packages/retrieval` with `KF_RETRIEVAL_ENGINE_BIN` set to the pinned binary.
- **evidence:** already recorded: 40 of 40, all ten real-engine tests, against LAMU `26923afb`,
  binary sha256 `c45c672ff498b6df36dbcff4829c4e480b2e79d2f084e37179f6959d6946e962`. Remaining: the
  running stacks' engine reports that build after restart.
- **falsification:** unset `KF_RETRIEVAL_ENGINE_BIN` and the real-engine tests must report
  skipped, not passed. A suite that passes without an engine says nothing about one.

### OBL-004 — the specification says what landed
- **scope:** KF-SAS-RQ-180, RQ-181, RQ-183.
- **checks:** `tests/conformance/sas-governance.test.ts`, `tests/deployment/normative-projection.test.ts`,
  `war check --generated`.
- **evidence:** a proposed revision whose digest matches the document; §100.40 closed, §100.21 and
  §100.39 restated, §100.17 and §100.24 pointing at `docs/ROADMAP.md`.

### OBL-005 — green, except what only the owner can do
- **scope:** the whole tree.
- **checks:** `pnpm gate`; the serial suite; `node scripts/war-check-gate.mjs`.
- **evidence:** every gate's exit status, each run to a file and tested, and a list of the errors
  that remain with the owner act that clears each. Today's known one:
  `authority.actor-not-human` on draft.8.
- **candidate gate (not registered):** `kf.repo.integration-green`, wrapping the three commands
  above with the owner-pending register as its only excuse list.

## Residual risk

**RR-001 — two B2 designs.** If Codex's schema cannot hold what the tailnet work records, the
port is a schema decision, not integration. Escalate; do not choose.

**RR-002 — the live stacks hold real fixture state.** A failed migration that switched before it
verified would lose version ids that append-only rows reference. Copy, verify, then switch.

## Independence

None. `openwarrant.toml` records all nine §46.1 dimensions as `false`, and `war check` says so.
