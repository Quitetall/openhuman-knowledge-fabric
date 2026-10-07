---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a7-7583-b041-90230e3158dc
role: assurance
jurisdiction: authored
order: 60
classification: internal
---

# Assurance

## Acceptance obligations

### OBL-001 — parity, measured, then accepted
- **scope:** ADR 0004 criterion 4, as amended by ADR 0032.
- **evidence:** for each constitution document, the two compilation digests, equal; the five
  lifecycle actions' act ids; a drift log stating zero unexplained drift; the owner's recorded
  acceptance of cutover. "No drift observed" with no compilations behind it is not evidence (ADR
  0004 says why).

### OBL-002 — the pack describes the ontology, and the owner signed it
- **scope:** ADR 0004 criterion 2; KF-SAS-RQ-152, RQ-153; SAS §100.6, §100.13.
- **checks:** `pnpm ontology:verify <pack> --key ontology/release-keys/release-1.pub` (or the key
  the owner signs with).
- **evidence:** `APPROVED`, against a pack built from the tagged commit's ontology.

### OBL-003 — every open gap has a disposition
- **scope:** SAS §100; KF-SAS-RQ-018.
- **evidence:** a scripted count, like the one in `docs/ROADMAP.md`: every open §100 entry in the
  accepted revision at the tag is either closed or marked an accepted limit with a reason. Counted
  from the SAS, not from this table.

### OBL-004 — the host is commissioned
- **scope:** ADR 0004 criterion 3; KF-SAS-RQ-168.
- **gate:** `gate://kf.host.commissioning@1.0.0`
- **evidence:** KF-WAR-0001 resolved, with `kf-commissioning --json` reporting every check
  `satisfied` after a reboot. A check reading `unverifiable` fails this obligation.

### OBL-005 — CI ran and passed on the tagged commit
- **scope:** ADR 0004 criteria 1 and 5; SAS §100.11; KF-SAS-RQ-181.
- **evidence:** the run id, the commit it ran on equal to the tag's, every job executed (none
  skipped for billing or configuration) and green; the release workflow green on the tag. The run
  history is read, not assumed: ADR 0004 records 38 runs that never started a job.

## Gate Adequacy

Required at `controlled` (§39.4).

**Adversarial question: could v1.0 be tagged while meaning less than ADR 0004 says?** That is the
risk ADR 0004 was written for: a true statement read as a larger one. The places it could happen:
a commissioning gate passing on a host whose failure domain is its builder's (KF-WAR-0001's RR-001,
which ADR 0039's VPS is meant to end); parity "met" by silence (OBL-001 requires the compilations);
a schema pack signed but stale (OBL-002 builds it from the tagged commit); and CI "green" without
running (OBL-005 reads the run).

**Could the gate be wrong?** `kf.host.commissioning@1.0.0` is qualified against nine fault classes
by planted defects (its definition says so); its own first blind spot is that it cannot tell a VM
on the workstation from independent hardware. ADR 0039 moves the host to a VPS so that blind spot
no longer matters.

**Executed attacks:** none yet.

- **outcome:** gap_accepted

Separation of duty on release approval is not achieved (ADR 0004): one person approves, accepts
and tags.

## Residual risk

**RR-001 — one approver.** As ADR 0004 records; it should end when a second engineer exists.

**RR-002 — accepted limits are still limits.** v1.0 ships with every §100 entry the owner accepts.
The tag says they were accepted, not that they were fixed.

## Independence

None today (`openwarrant.toml`); deliverable 4 is where that changes or is accepted.
