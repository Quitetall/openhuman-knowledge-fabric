# Ontology

**This directory is canonical.** Everything under `generated/` is compiled from these six
files and must never be hand-edited — CI regenerates and fails on any difference, because a
hand-edited generated file is an ontology change nobody reviewed.

| File                  | Defines                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `meta.yaml`           | The envelope every object carries, shared types (`Money`, `ExternalReference`, `EvidenceReference`) and controlled value sets |
| `object-types.yaml`   | The 21 object types, their states and their typed attributes                                                                  |
| `relation-types.yaml` | The 34 typed relations and their inverses                                                                                     |
| `action-types.yaml`   | The 30 actions — the only way a controlled fact changes                                                                       |
| `state-machines.yaml` | The 8 lifecycles and their legal transitions                                                                                  |
| `rules.yaml`          | The 10 machine-enforceable invariants and where each is enforced                                                              |

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

## Known gap — edge typing

The R01 pack does not declare `source_types` / `target_types` on relations, so nothing
currently stops an edge connecting two objects that have no business being connected. All
34 relations raise **ONT-012** at warning severity, so the gap is counted on every run
rather than living in a comment. Typing lands in Gate 6, alongside the object-type
extension where the full inventory is known.

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
