# Ontology

**This directory is canonical.** Everything under `generated/` is compiled from these seven
files and must never be hand-edited — CI regenerates and fails on any difference, because a
hand-edited generated file is an ontology change nobody reviewed.

| File                  | Defines                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `meta.yaml`           | The envelope every object carries, shared types (`Money`, `ExternalReference`, `EvidenceReference`) and controlled value sets |
| `object-types.yaml`   | The object types, their states and their typed attributes                                                                     |
| `relation-types.yaml` | The typed relations and their inverses                                                                                        |
| `action-types.yaml`   | The actions — the only way a controlled fact changes                                                                          |
| `state-machines.yaml` | The lifecycles and their legal transitions                                                                                    |
| `rules.yaml`          | The machine-enforceable invariants and where each is enforced                                                                 |
| `projections.yaml`    | The declared readings of a master record (ADR 0013): anchor, traversal and ordered sections                                   |

How many object, relation and action types there are today is in
[`generated/measurements.md`](../generated/measurements.md).

```sh
pnpm ontology:check    # validate + report drift in generated/. Never writes.
pnpm ontology:build    # regenerate generated/
```

## Provenance

Extracted once from the released `Knowledge_Fabric_OGWCS_R01_Schema_Pack.zip`
(`1.0.0-draft.1`, generated 2026-08-08), which is pinned byte for byte at
`tests/conformance/r01-golden/` and verified against its own manifest on every test run.

The extraction tool is deliberately **not** kept: shipping it would imply the pack is still
the source of truth. It is not — this directory is. The guarantee that the ontology still
means what the pack meant is `tests/conformance/r01-golden.test.ts`, which regenerates the
pack and requires the JSON Schema and vocabulary to be **identical**, with state machines
differing only at recorded defect paths.

## Corrections to the R01 draft

The consistency checker found five defects in the draft pack. The pack is
`draft_for_approval`, so finding them now is §5.1's consistency gate working as intended —
spec §1.2 makes a contradiction between prose and machine artifacts release-blocking.

| Id                 | Defect                                                                     | Resolution                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **R01-DEFECT-001** | `change_record.impact_domains` lost its 15 enum values in extraction       | _Our_ bug, not the pack's. Values restored; the checker caught it because an enum with no values can never validate.              |
| **R01-DEFECT-002** | `initiative_project.parked` is reachable, has no exit, and is not terminal | Added `parked → triage`. §11 calls parked a disposition with follow-up conditions; one you can never leave is a cancellation.     |
| **R01-DEFECT-003** | `decision_record.accepted` is terminal _and_ has `accepted → superseded`   | Removed `accepted` from terminal. §14.3 and §19 both define supersession as its exit.                                             |
| **R01-DEFECT-004** | `invoice.disputed` is reachable, has no exit, and is not terminal          | Added `disputed → approved` and `disputed → void`. §19 gives invoice only those two terminals.                                    |
| **R01-DEFECT-005** | `payment.reconciled` is terminal _and_ has `reconciled → reversed`         | Removed `reconciled` from terminal. §16.3 requires reversal to be a new attributable record, which is what the transition models. |

**R01 should not be approved as issued.** These five corrections belong in the pack before
it becomes normative.

## Edge typing

Every relation in `relation-types.yaml` declares `source_types` and `target_types` (SAS §100.2,
closed in draft.8). The seed mirrors them into `registry.relation_type_endpoint`, and
`core.relation`'s endpoint trigger (`20260925030300`) refuses an edge whose source or target type
is not declared for its end — against seeded data, so the ontology stays the authority. A relation
that omits either end is an ONT-012 **error**; it was a warning, counted on every run, while R01's
relations were untyped.

The generic relations (`linked_to`, `supersedes`, `derived_from`, `depends_on` and the PROV
relations) admit any type at both ends, written as the YAML anchor `*any_type` so the breadth is
declared rather than implied. `supersedes` in particular admits a pair of different types; a
same-type rule is not expressible in this grammar yet.

This narrows R01, which admitted every pair. `tests/conformance/edge-typing.test.ts` holds the
narrowing to two conditions — no R01 edge carried typing to be redefined, and every edge of R01's
own example graph is admitted — and the r01-golden comparison strips the typing only under them.

## Every type is created by an act

A type with no create act can only come into existence through an owner-credential insert —
no actor, no authority, no audit event. `tests/conformance/create-act-coverage.test.ts` maps
every object type to the act that creates it, or to a written reason it has none, and fails on
a type in neither list. The R01 product and quality types (`product_system`, `requirement`,
`risk`, `test`, `baseline`, `release`) gained create acts in draft.8 (KF-SAS-RQ-143); R01 gives
them states and no lifecycle, so each is born in its first declared state. The three work-control
types that had none gained them in draft.8 too (KF-SAS-RQ-142): `record_engagement`,
`plan_milestone` and `define_deliverable`, owned by `@kf/work-control`, each writing the typed row
that already existed (`org.engagement`, `work.milestone`, `work.deliverable`). None of the three
types has a state machine, so each is born in its first declared state (`draft`, `planned`,
`planned`) by the same rule.

`work.deliverable` now holds the ontology's `deliverable` fields (migration `20260925130100`). Its
columns predated them and differed (`deliverable_kind`, `definition_of_done`), and the ontology is
the one that was right: `deliverable` is an R01 type, which `tests/conformance/r01-golden.test.ts`
holds byte-identical to the released pack, and its `acceptance_criteria` are what an
`acceptance_record`'s `criteria_results` are judged against, which a single free-text
`definition_of_done` cannot be. The columns are `work_package_id`, `work_order_id` (optional, and
when given the order must cover the package — a composite key on `work.work_order_scope`),
`description`, `acceptance_criteria` and `due_date`; `artifact_refs` has no column because the
artifacts handed over for a deliverable are `work.deliverable_submission` rows, as the other
array-of-reference fields are child rows. Existing rows kept everything: `definition_of_done`
became the `description` and the one acceptance criterion, and both retired values are kept,
per deliverable, in `work.deliverable_retired_attribute` — read-only, exported, never written by
an application role. `define_deliverable` writes the ontology's fields.
`tests/database/deliverable-fields.test.ts` holds the table's columns equal to the ontology's
fields under that mapping.

`observation` (ADR 0034, proposed) is the one type whose create act is deliberately cheap:
`record_observation` needs a live assignment and no act grant, and the server forms the acting
assignment and the idempotency key (`formObservationRequest` in `@kf/work-control`).
`promote_observation` is institutional (`requires: act`); `withdraw_observation` is not. What an
observation is about is `concerns` relations from it, and a record it was promoted into is
`derived_from` it.

## Where each rule is enforced

`rules.yaml` says where each invariant is enforced; `tests/database/rule-ledger.test.ts` is the
record of whether it is. Every rule has a ledger entry citing a test that plants a violation,
and the citation is checked by title, so renaming or deleting the test fails the ledger. All
fifteen are live in the database or the dispatcher. The `validator` claim is counted
separately: the frozen R01 `validate_graph.py` refuses three declared rules (KF-GRAPH-001,
KF-FIN-001, KF-FIN-003 — its fourth check, invoice line totals, is not a declared rule), and
the ledger asserts that count against the validator's own source (SAS §100.1).

## The projection grammar is closed and bounded

`projections.yaml` is a closed grammar (SAS §60, KF-SAS-RQ-116). The loader refuses any key it
does not name — at the top of a definition and inside `traverse`, `filter`, `sections`,
`parameters`, `remainder` and `budgets` — because an ignored `max_detph` would read as a bound
and be none. Every definition declares `budgets.max_members` and `budgets.max_runtime_ms`, and
no definition may exceed the grammar's ceilings (`PROJECTION_GRAMMAR_LIMITS` in
`packages/ontology-compiler/src/model.ts`: depth 8, 30 000 ms, 100 000 members; ONT-018). The
engine (`@kf/projections`) re-checks the same ceilings on whatever definition it is handed and
turns `max_runtime_ms` into a deadline checked per node walked and per member placed: an
overrun is refused, never truncated.

What the depth ceiling bounds is `traverse.max_depth` — the anchor's first stance. After the
first hop, composition and provenance walk to a fixpoint, bounded by the corpus (and so by
`max_members`) and by the runtime deadline rather than by depth. That is deliberate, recorded in
`packages/projections/src/closure.ts`: a depth cut there would turn a budget into silent
membership loss.

## Editing

1. Change the YAML.
2. `pnpm ontology:check` — the checker runs before anything is written, and refuses to emit
   artifacts if the ontology is inconsistent.
3. `pnpm ontology:build`, then commit `ontology/` and `generated/` together.

Adding a new object, relation, action or state requires a use case, an owner, an authority
domain and validation rules (§30.1). Released schema versions are immutable; incompatible
changes increment MAJOR.

### Why generated files carry no build timestamp

The directive asks for a generation timestamp in every artifact header. Every artifact
instead carries `source_digest` — SHA-256 over the canonicalized ontology model — and no
wall-clock time.

A build time would change on every run and make the generated-versus-committed drift check
fire constantly, burying real changes in noise, which would defeat the stronger requirement
that CI fail when generated output differs. The digest answers the same question better:
it identifies exactly which ontology produced these bytes, and two artifacts with the same
digest are the same artifact regardless of when they were written. A test asserts no
artifact embeds anything that looks like a timestamp.
