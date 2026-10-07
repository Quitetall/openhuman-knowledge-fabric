---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a5-7322-8054-141d19584829
role: assurance
jurisdiction: authored
order: 60
classification: internal
---

# Assurance

## Acceptance obligations

### OBL-001 — the human evidence exists, from the host
- **scope:** KF-SAS-RQ-049, RQ-164, RQ-171; ADR 0004's two blockers no automation can close.
- **evidence:** the owner's own statement, recorded as an observation in KF, that he signed in
  through the real realm and received an alert and a push on his phone, with the date. A test
  cannot substitute for it and none is offered.

### OBL-002 — every bar has a host figure
- **scope:** KF-SAS-RQ-201; SAS §100.18.
- **checks:** `scripts/latency-bars.mjs` run on the host.
- **evidence:** every ADR 0024 bar with a figure measured on the host, including the two the owner
  timed; §100.18 narrowed or closed in the next SAS proposal.

### OBL-003 — no finding is lost
- **scope:** every finding the owner records against this Warrant during the pass.
- **evidence:** the count of findings recorded equals the count dispositioned (fixed with a test,
  moved to a named Warrant, or recorded as decided), counted from KF, not from a summary.
- **falsification:** a fix's test must fail on the code before the fix; a fix without such a test
  is recorded as unverified.

## Residual risk

**RR-001 — one user.** The pass is one person's use. It finds what the owner does; it says nothing
about what a second person would trip on, which is what M5's first invitees are for.

## Independence

None (`openwarrant.toml`). The judge of the pass is also the product owner, by design.
