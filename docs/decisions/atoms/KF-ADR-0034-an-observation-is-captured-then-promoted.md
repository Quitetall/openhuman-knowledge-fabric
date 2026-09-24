---
schema: oh.war/atom/v1
adr_uuid: 1a31147f-7ca9-55cb-b934-de7f9cedeb70
local_alias: KF-ADR-0034
role: adr
jurisdiction: bound
order: 30
classification: public
status: accepted
decided: 2026-09-24
---

# ADR KF-0034: An observation is captured in one gesture, and promoted by a separate act

- **Status:** accepted 2026-09-24; proposed 2026-09-24
- **Decision owner:** technical authority
- **Scope:** the object type ADR 0024 left unnamed, and what capturing and promoting one costs
- **Carries:** KF-SAS-RQ-200, RQ-202, RQ-203; closes the type half of §100.18

## Context

ADR 0024 decided that capture is cheap and governance applies at promotion, and that an
observation enters "as an ordinary object in a draft lifecycle state". It did not name the type,
so nothing can be captured: every surface still has to pick an existing record type, supply an
acting role, an idempotency key and a row version, and that is the friction 0024 exists to remove.

## Decision

1. **One object type, `observation`.** Fields: `body` (Markdown, required), `observed_at`
   (defaults to the database clock), `subjects` (zero or more object ids it is about, as
   `concerns` relations), `tags`. Lifecycle: `captured` → `promoted` | `withdrawn`.
2. **`record_observation` is not institutional.** It needs any live assignment in the
   organization — no act grant, no approval — and the server forms everything else: the acting
   assignment (the caller's only live one, or the one named), the idempotency key (gesture id plus
   body digest), the target. One gesture, one act (RQ-227).
3. **An observation is unverified until somebody verifies it**, exactly as any record (§48A).
4. **`promote_observation` is institutional** (`requires: act`): it moves `captured` → `promoted`
   and, when the observation is being turned into a controlled record of another type, creates
   that record through that type's own create act in the same transaction, citing the observation.
5. **Every surface uses the same two acts** (RQ-203): `POST /capture/observation`, `kf note`, the
   web capture form, and agents through the same route.

## Options rejected

- **Draft state on every existing type instead of a new type.** Most state machines have no draft
  state (the conflation `draft.6` corrected); adding one to each changes most lifecycles.
- **Capture into a side table outside `core.object`.** A second shape for one fact — the drift
  ADR 0024 forbids — and unattributed until promoted.
- **Let the surface choose the acting role.** That is the detail RQ-200 says the actor never
  supplies.

## How we will know

`record_observation` from `kf note` and the web form completes with no role, key or version in the
request (a test asserts the request body carries none), and ADR 0024's capture bar is measured
against it by the latency harness.

## Consequences

The ontology gains one type and three acts, which re-cuts the schema pack (§100.6: a re-sign).
