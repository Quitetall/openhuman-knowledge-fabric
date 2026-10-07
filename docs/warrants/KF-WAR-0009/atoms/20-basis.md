---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a7-7583-b041-90230e3158dc
role: basis
jurisdiction: authored
order: 20
classification: internal
---

# Basis

- **ADR 0004** (`docs/decisions/0004-production-release.md`), as amended by **ADR 0005** (licence)
  and **ADR 0032** (`docs/decisions/0032-the-seven-day-floor-is-waived.md`).
- **SAS §98 Phase 10** and **§99** (the 28 acceptance criteria); the accepted SAS revision at the
  time of tagging, whose record must match its bytes (KF-SAS-RQ-181).
- **KF-WAR-0001** (the commissioned host) and **KF-WAR-0008** (the owner's pass), both resolved.

## The open §100 entries this Warrant must close or accept

Assigned here by `docs/ROADMAP.md`'s gap table; each needs a disposition before the tag:

| Entry | What remains | Likely disposition |
|---|---|---|
| §100.1 | the frozen `validate_graph.py` checks three rules | pack re-cut, or accepted limit |
| §100.3 | `meta.yaml` pins `OH-`; `damm.ts` couples | fix `damm.ts`; the pin is a governance act |
| §100.6 | signed packs no longer describe their source | re-cut `1.0.0-draft.5` and the owner signs |
| §100.11 | CI never green on a tagged commit | criterion 5 |
| §100.13 | the release pack says its manifest is unsigned | fix in the re-cut |
| §100.14 | verification independence is nil | arrange a verifier, or the owner accepts |
| §100.25 | fusion measured on four public corpora only | measure on the real corpus after M7, or accept |
| §100.27 | untagged digests remain | tag them, or accept each with its reason |
| §100.28 | the owner has not confirmed RQ-038's reading | owner confirms by accepting the revision |
| §100.32 | old archives with reverted columns are untested | a test, or accept |
| §100.35 | compiler determinism is not re-run on a schedule | a scheduled re-run |
| §100.36 | a history read pays the audit policy per event | measure on the host |

## Existing tools this reuses

- `pnpm ontology:pack` and `pnpm ontology:approve` (approval is the owner's).
- `dogfood/document-constitution.json` for the parity corpus.
- `tests/conformance/digest-tags.test.ts` (its `UNTAGGED` list is §100.27's work list).
- `.github/workflows/ci.yml` and `.github/workflows/release.yml`.
- `docs/gates/kf.host.commissioning@1.0.0.yaml`.
