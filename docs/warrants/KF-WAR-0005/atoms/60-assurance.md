---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a0-76f3-97a5-dc84fe99ad07
role: assurance
jurisdiction: authored
order: 60
classification: internal
---

# Assurance

No registered gate covers this work; `kf.scope.presets` is proposed below as a candidate.

## Acceptance obligations

### OBL-001 — a role never widens past what its preset declares
- **scope:** KF-SAS-RQ-039, RQ-041; the M1 requirement on roles as presets.
- **checks:** database tests on the grant view, against a real PostgreSQL; the existing suites in
  `tests/permissions/` unchanged and green.
- **evidence:** for every Véracier persona, the effective grants after the change equal the union
  of their role presets, computed independently in the test, row for row.
- **falsification:** plant a preset whose ceiling is above the person's clearance; the session
  ceiling must still be the clearance (KF-SAS-RQ-038), and the grant must cap at it.

### OBL-002 — inclusion is acyclic and is not delegation
- **scope:** KF-SAS-RQ-040, RQ-246.
- **evidence:** the database refuses a cycle by name (A includes B includes A, and the longer
  cycle); an assignment of a composite role still ends within 366 days; no row of the grant view
  overlaps another for the same principal, scope and capability.
- **falsification:** remove the cycle check and the cycle test must hang or fail, not pass.

### OBL-003 — a denial or a grant explains its role path
- **scope:** KF-SAS-RQ-042.
- **evidence:** the access explanation for a grant that came from an included role names every
  role on the path, and its digest is `kf-access-explanation-v2` over RFC 8785.

### OBL-004 — no grant on the overview, no overview
- **scope:** KF-SAS-RQ-110, RQ-113; the M1 requirement on master document = compile(scope).
- **evidence:** the owner's own example as a test: a person with no grants gets a master record and
  no overview; the same person added to the overview's scope gets a master record that includes it.
  Every overview statement links to a record the reader may read.

### OBL-005 — the master document is fast enough to be read
- **scope:** KF-SAS-RQ-112, RQ-201; SAS §100.42, §100.43.
- **checks:** `scripts/latency-bars.mjs` on the multi fixture.
- **evidence:** before and after figures, the after within ADR 0024's bars, and §100.42 and §100.43
  closed or narrowed in the next SAS proposal with the measurement cited.

### OBL-006 — one layout, no role branches, usable on a phone
- **scope:** KF-SAS-RQ-157; the M1 requirements on one dashboard and on phone use.
- **checks:** a test that fails if any web route, component or API handler names a role or title;
  a phone-width browser run of read, verify and capture.
- **evidence:** the role-name test passing with a planted role branch making it fail first; a
  recorded phone-width run of reading the master document, one-click verify and a photo capture.
- **candidate gate (not registered):** `kf.scope.presets`, running OBL-001 to OBL-004 with their
  plants.

## Gate Adequacy

Required at `controlled` (§39.4).

**Adversarial question: could a role preset let someone read what no person ever decided they
should?** Yes, in two ways this Warrant must close: a cycle or a long inclusion chain that nobody
reviewing one role can see the end of (OBL-002, and OBL-003 makes the path visible), and a preset
that silently outruns clearance (OBL-001). A third, a preset edited to widen and then narrowed back
before anyone looked, is answered by the preset change being an attributed act in the audit chain,
not by any check here.

**Could the checks be blind?** OBL-001 compares the view against an independent computation, not
against itself, and each obligation carries a plant that must fail first.

**Executed attacks:** none yet.

- **outcome:** gap_accepted

Who reviews a role preset before it is used is an organizational question this Warrant cannot
answer; it records the act and shows the path.

## Residual risk

**RR-001 — a broad preset is a broad grant.** "All engineering documents" is exactly as wide as
the owner makes it. The system shows the path; it does not judge the breadth.

## Independence

None (`openwarrant.toml`).
