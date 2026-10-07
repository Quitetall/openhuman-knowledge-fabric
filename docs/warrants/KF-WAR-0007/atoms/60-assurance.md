---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a4-7fc0-8849-5349ef95a2f0
role: assurance
jurisdiction: authored
order: 60
classification: internal
---

# Assurance

No registered gate covers this work; `kf.qualification.protocol` is proposed below as a candidate.
ADR 0038 already wrote the acceptance tests; this atom binds each to an obligation.

## Acceptance obligations

### OBL-001 — one protocol, roles are data
- **scope:** KF-SAS-RQ-254, RQ-255.
- **evidence:** ADR 0038's "a new role: a pack is added and no code changes" as a test that adds a
  third Véracier pack in a fixture and changes no file outside it; a test that fails if any
  evaluator, route, view or policy names a role or title.

### OBL-002 — evidence is what it says, credited once, by the right person
- **scope:** KF-SAS-RQ-256, RQ-257, RQ-047.
- **evidence:** planted cases for ADR 0038's rows: two packs sharing a requirement satisfy it once;
  existing accepted evidence is credited without repeating the work; every requirement evidenced
  through accepted work closes the record with no second approval; an acknowledged requirement is
  never recorded as demonstrated.
- **falsification:** a reviewer crediting their own work must be refused (KF-SAS-RQ-047).

### OBL-003 — qualification grants nothing and is checked only where declared
- **scope:** KF-SAS-RQ-258, RQ-259.
- **evidence:** ADR 0038's rows: a person qualified for the baseline but not a specialized
  requirement succeeds at the baseline action and is refused the specialized one, the refusal naming
  the requirement; an absent grant is not bypassed by qualification; an unrelated document revision
  changes no status; a behavioural revision of one requirement gives exactly the affected people
  exactly that gap.

### OBL-004 — the organization's blocker is never the person's failure
- **scope:** KF-SAS-RQ-260, RQ-261.
- **evidence:** ADR 0038's row: a mandatory resource that is inaccessible shows the organization's
  blocker and the contact, not a failure; the validator refuses a mandatory requirement with no
  stated consequence.

### OBL-005 — joining works end to end, and Start Here is never edited
- **scope:** KF-SAS-RQ-113, RQ-022; the M1 requirements on invite and Start Here.
- **evidence:** one Véracier persona per pack walked from invitation to an accepted first
  contribution through the web app, recorded; Start Here regenerated from the record matches what
  was shown; the re-cut pack declares the two types as additions.
- **candidate gate (not registered):** `kf.qualification.protocol`, running ADR 0038's nine rows
  as planted cases, each required to fail on its plant first.

## Gate Adequacy

Required at `controlled` (§39.4).

**Adversarial question: could a reading checklist manufacture authority, or a person be marked
unqualified for the organization's failure?** These are the two failures ADR 0038 exists to
prevent. The first is closed in the database (OBL-003: qualification grants nothing, a permission
implies none, and the planted absent-grant case must be refused). The second is closed in the
record (OBL-004: a blocker is the organization's, by construction of the state).

**Could the checks be blind?** ADR 0038 wrote its tests before the code existed, so they test the
decision, not the implementation's reading of it.

**Executed attacks:** none yet.

- **outcome:** gap_accepted

Founding authority is one person (ADR 0038, decision 13): the technical authority approves the
packs that later judge others. Recorded, not presented as independent evaluation.

## Residual risk

**RR-001 — self-attested founding authority.** As above, and as ADR 0004 records for release
approval.

**RR-002 — the agent guide can be wrong.** It explains and assembles; it credits nothing. A wrong
explanation costs time, not a false qualification.

## Independence

None (`openwarrant.toml`).
