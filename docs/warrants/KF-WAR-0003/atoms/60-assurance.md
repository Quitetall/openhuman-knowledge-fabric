---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-339c-7c52-b3e9-0fe9773b6c63
role: assurance
jurisdiction: authored
order: 60
classification: internal
---

# Assurance

## Acceptance obligations

### OBL-001 — every decision has its rejected options and its test
- **scope:** ADR 0040; KF-SAS-RQ-182.
- **checks:** `tests/conformance/decision-records.test.ts`.
- **evidence:** the ADR passes that test, and each of the twelve decisions names at least one
  rejected option and one planted case that would show it wrong.
- **falsification:** delete the `## Options rejected` heading from the new ADR and the test must
  fail naming ADR 0040; restore it.

### OBL-002 — the requirements are append-only and resolvable
- **scope:** KF-SAS-RQ-183, RQ-184.
- **checks:** `tests/conformance/sas-governance.test.ts`, `tests/conformance/resolve-sas-citations.test.ts`,
  `war check --generated`.
- **evidence:** §106, the revision record and the inline statements name the same set; no existing
  identifier moved; `node scripts/resolve-sas-citations.mjs docs/warrants` resolves every new
  citation.

### OBL-003 — nothing unbuilt reads as built
- **scope:** KF-SAS-RQ-018, RQ-171.
- **evidence:** one §100 entry per new requirement that has no implementation, each naming the
  Warrant that builds it. Counted, not described: the number of new requirements equals the number
  of entries plus the number with a cited implementation (expected: zero).

### OBL-004 — the hinge holds
- **scope:** KF-WAR-0004 to KF-WAR-0007 manifests.
- **checks:** `war check --generated`.
- **evidence:** each dependent Warrant implements at least one new requirement, `war check`
  reports `traceability.refs` passing for each, and no `traceability.unknown-requirement`.
- **falsification:** cite a requirement one past the last new identifier in one manifest; `war
  check` must report `traceability.unknown-requirement`; restore.

## Residual risk

**RR-001 — a requirement written from a chat is a reading of it.** The owner's words are quoted
where they decide something; anything the ADR infers beyond them is marked as the author's reading
until the owner accepts the revision.

## Independence

None (`openwarrant.toml`).
