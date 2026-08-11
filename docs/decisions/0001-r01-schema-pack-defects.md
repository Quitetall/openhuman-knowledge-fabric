# R01 schema pack — five defects and their corrections

**Status:** open — requires the pack owner's decision
**Against:** `Knowledge_Fabric_OGWCS_R01_Schema_Pack.zip`, version `1.0.0-draft.1`, generated 2026-08-08
**Raised by:** the ontology consistency checker, Gate 2
**Corrected package:** `pnpm ontology:pack` → `release/knowledge-fabric-1.0.0-draft.2/`

---

## Why this exists

The pack is `draft_for_approval`. Spec §1.2 makes a contradiction between prose and machine
artifacts a **release-blocking defect**, and §5.1's consistency gate exists to surface exactly
these before approval. Five surfaced. Four are the pack's; one was ours.

**R01 should not be approved as issued.** Each defect below is either a state a record can
enter and never leave, or a state declared terminal that has a defined way out — both of
which make a lifecycle unimplementable as written.

## Evidence

Each was confirmed against the golden pack independently of the compiler, by reachability
analysis over `knowledge-fabric.state-machines.json`:

```
initiative_project: terminal=[administratively_closed, cancelled, rejected]
   DEAD END (reachable, not terminal, no way out): ['parked']
decision_record:    terminal=[accepted, rejected, superseded, withdrawn]
   LEAVES A TERMINAL STATE: [('accepted', 'superseded')]
invoice:            terminal=[paid, void]
   DEAD END (reachable, not terminal, no way out): ['disputed']
payment:            terminal=[failed, reconciled, reversed]
   LEAVES A TERMINAL STATE: [('reconciled', 'reversed')]
```

## The defects

### R01-DEFECT-001 — _ours, not the pack's_

`change_record.impact_domains` lost all 15 enum values during our extraction of the pack into
`ontology/`. The pack was always correct.

Caught because an enum with no values can never validate — a field that would have rejected
every conforming record. A subsequent scan of every enum in the pack confirmed this was the
only loss. **No action required of the pack owner**, recorded because it is the clearest
evidence the consistency gate earns its place.

### R01-DEFECT-002 — `initiative_project.parked` is a dead end

`captured → parked` and `triage → parked` exist; nothing leaves `parked`, and it is not
terminal. A parked initiative could never resume or be dispositioned.

**Correction:** add `parked → triage` (`triage_initiative`).
**Basis:** §11 describes parked as a non-active disposition that _"preserves history"_ with
_"follow-up conditions"_. A disposition you can never leave is a cancellation, and the model
already has one.

### R01-DEFECT-003 — `decision_record.accepted` is terminal and has an exit

`accepted` appears in `terminal` while `accepted → superseded` is defined. Both cannot hold.

**Correction:** remove `accepted` from `terminal`, leaving `[rejected, superseded, withdrawn]`.
**Basis:** §14.3 — _"Accepted/rejected ADRs are immutable. A new ADR supersedes the old
record"_ — and §19's lifecycle, which lists `accepted -> superseded` explicitly. Immutable is
not the same as terminal: the record never changes, but its status does.

### R01-DEFECT-004 — `invoice.disputed` is a dead end

`submitted → disputed` exists; nothing leaves `disputed`, and it is not terminal. A disputed
invoice could never be resolved.

**Correction:** add `disputed → approved` (`approve_invoice`) and `disputed → void`
(`correct_record`).
**Basis:** §19 gives invoice only `paid` and `void` as terminals, so a dispute must resolve
onto one path or the other — upheld and approved for payment, or withdrawn.

### R01-DEFECT-005 — `payment.reconciled` is terminal and has an exit

`reconciled` appears in `terminal` while `reconciled → reversed` is defined.

**Correction:** remove `reconciled` from `terminal`, leaving `[reversed, failed]`.
**Basis:** §16.3 requires that _"a reversal, refund or fee is a new attributable record;
settled records are not silently edited."_ That is precisely what the transition models, so
the transition is right and the terminal designation was wrong.

## What the corrected package is

`release/knowledge-fabric-1.0.0-draft.2/` — nine files under a manifest, using the spec's
filenames so it is a drop-in successor rather than a differently-shaped artifact.

- Five files regenerated from `ontology/`: schema, vocabulary, state machines, JSON-LD
  context, SHACL.
- Three carried forward from R01 unchanged, because the corrections do not touch them: the
  BPMN process model, the Atlas conformance example, and `validate_graph.py`.
- A manifest recording `supersedes: 1.0.0-draft.1`, the four corrections, the ontology source
  digest, per-file SHA-256, and the known gaps below.

The JSON Schema and vocabulary are **byte-for-byte identical in meaning** to R01 — asserted
by `tests/conformance/r01-golden.test.ts`, which regenerates them and requires zero
differences. Only the state machines change, and only at the four paths above.

## Known gaps travelling with the corrected package

Recorded in the manifest so approval is an informed act, not an assumption.

1. **`validate_graph.py` implements four of the ten invariants.** Six exist only in prose,
   which §27.1 calls nonconforming. Gate 3 closes this by making all ten simultaneously a
   database constraint, an action precondition and a conformance test.
2. **Relations declare no `source_types`/`target_types`**, so nothing constrains which object
   types an edge may connect. Tracked as ONT-012 on every checker run; typing lands in Gate 6.
3. **The manifest is unsigned.** §5 requires a signed or approved release manifest before the
   package is normative, and §1.2 means the prose document must be corrected and released
   _together with_ it as one configuration item.

## Decision required

1. Accept the four corrections into the controlled document (§19's lifecycle tables), or
   reject them with an alternative resolution for each dead end and contradiction.
2. Approve and sign `1.0.0-draft.2`, or direct that the gaps above be closed first.

Until then the pack remains non-normative under §1.2, and this repository treats
`ontology/` as the working definition with every divergence enumerated and tested.
