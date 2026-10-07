---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a0-76f3-97a5-dc84fe99ad07
role: basis
jurisdiction: authored
order: 20
classification: internal
---

# Basis

## The contract

- **ADR 0040** (to be written by KF-WAR-0003) and decisions 5, 6, 7, 10 and 12 of
  `docs/ROADMAP.md`. Their requirements (one dashboard scoped by grants; master document =
  compile(scope); roles as composable scope presets; phone read/verify/capture) **do not exist in
  §106 yet**; KF-WAR-0003 adds them to this manifest when it lands.
- **ADR 0016** and **ADR 0027**: access is a grant, on every read. A role preset must reach a
  reader only as rows of `org.effective_access_grant`, the view both the read path and the write
  path consult (KF-SAS-RQ-041). Changing that view's sources is a change to the authority model:
  it needs a migration, a note appended to ADR 0016 (or a new ADR if the owner prefers), and the
  owner's acceptance.
- **ADR 0036**: delegation is one level and assignments expire. Role inclusion is composition of
  presets, not delegation; it must not become a way to chain authority past one level, and an
  assignment of a composite role still ends within 366 days.
- **ADR 0013**, **ADR 0014**, **ADR 0015**: master identity is the corpus; every reading is a
  declared projection; Object Views come from ontology metadata.
- **ADR 0024**: friction is architectural. SAS §100.42 and §100.43 are its open entries for the
  master record at scale.
- SAS §15 (roles today are a flat list of names, `org.role` in
  `database/migrations/20260811000700_org.sql`), §18, §19.

## Existing code this reuses

| Need | Where it already is |
|---|---|
| The one grant view | `database/migrations/20260902000100_access_grants.sql` (`org.effective_access_grant`); `database/migrations/20260911000200_grants_gate_every_read.sql` makes every read consult it |
| Explaining access | `apps/api/src/routes/documents/access-explanation-route.ts` |
| Master record and its projections | `apps/api/src/routes/documents/master-record-projection-route.ts`; `packages/projections/src`; `ontology/projections.yaml` |
| Object View | `apps/api/src/routes/documents/object-view-route.ts` |
| A generated overview to learn from | `apps/api/src/overview/render.ts` (the control record, `kf overview`) |
| Web app | `apps/web/src/app/page.tsx`, `apps/web/src/app/globals.css`, `apps/web/src/app/objects`, `apps/web/src/app/capture` |
| Needs you | KF-WAR-0004's route and panel |

## The unknown

Whether a role preset is best a new source in `org.effective_access_grant` (a union branch that
expands a person's role assignments through role inclusion) or materialized grants written by an
act when a role changes. The first keeps one truth and costs a recursive read on every check; the
second is fast and needs every role change to rewrite grants atomically. Measure both on the multi
fixture (:3200) before choosing, and record the measurement in the ADR note.
