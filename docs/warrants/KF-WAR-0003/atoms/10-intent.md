---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-339c-7c52-b3e9-0fe9773b6c63
role: intent
jurisdiction: authored
order: 10
classification: internal
---

# Intent

Write the experience the owner decided on 2026-10-06 into the two places this repository holds
decisions and requirements, so that the four milestones that build it (M2 to M5) implement
requirements rather than a chat transcript, and so a gate can tell when the app departs from them.

This is milestone **M1, Spec the experience**. It produces:

- **ADR 0040**, "The experience: one home, one agent, verified by authority": the twelve UX
  decisions of `docs/ROADMAP.md`, the options rejected for each, and how we will know each was
  wrong.
- **A SAS section** stating them as numbered requirements (new identifiers, continuing from the
  last in §106), and one §100 entry for every part that is not built.

The owner chose this home on 2026-10-06 ("ADR + SAS section for now"), and intends to ask
OpenWarrant for a native UX/DX document type later. If that type lands, this content moves into
it by supersession; nothing here should assume it will.

## Why a Warrant and not an edit

Four later Warrants name requirements this one creates, and `war check` refuses a Warrant that
implements a requirement §106 does not hold. Until this lands, KF-WAR-0004 to KF-WAR-0007 can only
cite the existing requirements their work touches. The new identifiers are the hinge.

## What is deliberately not in scope

- Building anything. Every requirement this Warrant writes is recorded unbuilt, in §100.
- Deciding anything the owner did not decide. Where the transcript leaves a choice open (the
  digest's send time, what counts as "urgent"), the ADR names it as open, with a default and who
  decides it.
