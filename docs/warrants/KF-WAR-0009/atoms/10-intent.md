---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a7-7583-b041-90230e3158dc
role: intent
jurisdiction: authored
order: 10
classification: internal
---

# Intent

Cut Knowledge Fabric v1.0, meaning what ADR 0004 says it means: the software is complete, it runs
on a commissioned host, its schema pack is signed and current, cutover is accepted, and CI is green
on the commit being tagged. Nothing less is tagged 1.0.

This is milestone **M8, v1.0**, and the exit of SAS §98 Phase 10 (`roadmap://KF-PHASE-10/exit`):
"every criterion in the v1.0 decision record is met, and the tag is cut."

## The criteria, from `docs/decisions/0004-production-release.md`

1. The software is complete and every gate `ci.yml` defines passes from a clean checkout, in CI, on
   the tagged commit.
2. The R01 schema pack is approved and signed. Met on 2026-08-19 for `1.0.0-draft.2`, but SAS
   §100.6 records that the signed packs no longer describe their source; v1.0 needs a re-cut pack
   the owner signs, in sync with the ontology it describes.
3. One host is commissioned and `kf-commissioning` reports every check `satisfied`
   (KF-WAR-0001).
4. The document-compiler parity criterion is met and cutover accepted: each constitution document
   compiled twice byte-identically, the five lifecycle action paths exercised, zero unexplained
   drift. The seven-day floor is waived by ADR 0032.
5. A CI run has executed and passed on the tagged commit.

And from this roadmap: every open SAS §100 entry is closed or recorded as an accepted limit, and
independent verification is arranged or its absence recorded as the owner's decision (§100.14).

## What is deliberately not in scope

- A public release decision beyond the tag (ADR 0004 leaves publication separate).
- Anything after v1.0. The phase ladder has no number for it (SAS §100.24); `docs/ROADMAP.md`
  schedules it.
