---
schema: oh.war/atom/v1
warrant_uuid: 01a084e1-5936-7bc3-bb49-777cdd4bb598
role: assurance
jurisdiction: authored
order: 60
classification: internal
---


# Assurance

## Acceptance obligations

Each names what would have to be TRUE, and what evidence distinguishes it from a claim. Evidence
produced on the workstation satisfies none of them.

### OBL-001 — bytes survive the loss of one device
- **scope:** SAS KF-SAS-RQ-095, KF-SAS-RQ-097; SAS §100.4.
- **gate:** `gate://kf.host.commissioning@1.0.0`
- **evidence:** one artifact version with two `content.artifact_location` rows on different
  physical devices, each carrying its own verified digest, written by recorded
  `replicate_artifact_version` and `verify_artifact_location` acts. Then: remove the working
  copy and serve the bytes from the durable one. A location row that was never verified is not
  evidence, which is why the digest and not the row is the artifact.

### OBL-002 — every unit runs under its own account, from a timer, unattended
- **scope:** KF-SAS-RQ-163.
- **gate:** `gate://kf.host.commissioning@1.0.0`
- **evidence:** `systemctl` output naming each unit, its account, and its last timer-driven run.
  A unit started by hand proves the binary works; a unit fired by its timer proves the deployment
  does.

### OBL-003 — the API cannot read the checkpoint signing key
- **scope:** KF-SAS-RQ-167.
- **gate:** `gate://kf.host.commissioning@1.0.0`
- **evidence:** a signed checkpoint that verifies, AND a read of the key attempted as the API's
  service account and refused by the filesystem. The refusal is the obligation; the signature
  alone only shows the signer worked.

### OBL-004 — a backup was verified where it landed, and restored
- **scope:** KF-SAS-RQ-165, KF-SAS-RQ-166.
- **gate:** `gate://kf.host.commissioning@1.0.0`
- **evidence:** a backup manifest verified at the destination rather than the source, and a
  restore drill run with the SHIPPED scripts into a scratch database, reporting what it restored.
  A backup is not valid until it has been restored.

### OBL-005 — the host answers after a reboot it was not watched through
- **scope:** KF-SAS-RQ-161, KF-SAS-RQ-162, KF-SAS-RQ-168.
- **gate:** `gate://kf.host.commissioning@1.0.0`
- **evidence:** preflight re-run after a cold boot, and `kf-commissioning --json` exiting zero
  with no check reading `unverifiable`. That program fails on "we could not look", so a zero exit
  is the claim and the JSON is the record of it.

### OBL-006 — what no check covers is written down
- **scope:** KF-SAS-RQ-169, KF-SAS-RQ-171.
- **gate:** `gate://kf.host.commissioning@1.0.0`
- **evidence:** an enumeration committed to the repository, each entry naming why no automated
  check can cover it. An earlier revision of the deployment contract claimed blanket coverage
  that was untrue of four items, which is the specific failure this obligation exists to prevent.

## Gate Adequacy

Required at `controlled` (§39.4).

**Adversarial question: could this host pass every check and still not be commissioned in any
sense that matters?** Yes, and it is the failure this Warrant is most exposed to.

`kf-commissioning` reads a host. It cannot tell whether that host is independent hardware or a
virtual machine on the workstation that built the software — the gate's own blind-spot list says
so first, before its fault model. Every check can go green on a machine that dies with its
builder. Nothing visibly breaks. The Warrant resolves, criterion 3 of ADR 0004 is marked met, and
the property that died is one nobody looks at until the workstation fails.

That is why RR-001 is recorded as accepted residual risk rather than closed, and why OBL-001 is
written as *serve the bytes from the durable copy after removing the working one* rather than
*two location rows exist*. A row is a claim about storage; a served byte is storage.

**The second adversarial question: could the gate itself be wrong?** It is unqualified. No plant
battery exists for it, so its eight declared fault classes are asserted rather than demonstrated,
and its `qualification_digest` is empty rather than fabricated. A PASS from an unqualified gate
is a report. Qualifying it is inside this Warrant's scope, and this Warrant cannot cite its own
gate's qualification as evidence for itself.

**Executed attacks:** none yet — this Warrant has not been executed. The plants are named in
OBL-001 (remove the working copy), OBL-003 (attempt the key read as the API account) and OBL-005
(reboot without watching), and each is an attack rather than an observation because each requires
the system to be in a state it was not left in.

- **outcome:** gate_added, gap_accepted

`gate_added`: this review produced `kf.host.commissioning@1.0.0`, the first gate definition in
this repository, because the obligations had nothing to cite. `gap_accepted`: two of Phase 9's
exit conditions — a person receiving an alert, and real-provider browser evidence — are outside
every gate here and are carried as RR-003 rather than counted as covered.

Adequate with those limits recorded. The obligations detect what they claim for the configuration
properties, and claim nothing about the two that no gate can reach.

## Residual risk

**RR-001 — this host runs on the workstation's hardware.** It is a separate operating system,
kernel, service set and credential set, and it found five missing host requirements the first
time it was qualified. It shares a power supply and a motherboard, so it cannot evidence
availability under a hardware failure of the machine it runs on. Accepted for dogfood; it must
not be cited as evidence of an availability property.

**RR-002 — one person is technical authority, quality authority and accepting party.** ADR 0004
records this and its consequence: a mistaken approval has no second reader. Unchanged by this
Warrant.

**RR-003 — two obligations of Phase 9 are not reachable from here at all.** A person receiving an
alert, and real-provider browser evidence. This Warrant installs the alert path and exercises it;
it cannot make a human confirm receipt. KF-SAS-RQ-164 is therefore `partial` by construction and
not by omission.

## Independence

`openwarrant.toml` records all nine §46.1 dimensions as `false`. This repository is authored and
verified by one person working with one agent: no blind reviewer, no separate workspace, no
separate context compilation. §27.4 is explicit that role separation by one person is not
organizational independence.

A `controlled` Warrant does not meet §46.3's minimum under those conditions, and `war check` will
say so. That report is correct and is not a misconfiguration.
