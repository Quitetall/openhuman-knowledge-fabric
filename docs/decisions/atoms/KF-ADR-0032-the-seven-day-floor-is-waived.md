---
schema: oh.war/atom/v1
adr_uuid: e424fa5f-b1a1-56e4-bd7c-d488f22bfbfb
local_alias: KF-ADR-0032
role: adr
jurisdiction: bound
order: 30
classification: public
status: accepted
decided: 2026-09-20
---

# ADR KF-0032: The seven-day floor on compiler cutover is waived, and what that gives up

- **Status:** accepted 2026-09-20; proposed 2026-09-20
- **Amends:** [ADR 0004](KF-ADR-0004-production-release.md)'s replacement criterion. The other
  three conditions stand unchanged.

## Context

ADR 0004 set four conditions for compiler cutover: each of the three constitution documents
compiled at least twice with byte-identical output, each of the five document-lifecycle action
paths exercised at least once, zero unexplained semantic drift, and at least seven days elapsed.

That record is explicit about what the day floor is for, and it is worth quoting rather than
paraphrasing: _"The day floor is not evidence. It exists so that a burst of activity in one
afternoon cannot satisfy the criterion, because some drift is only visible across a restart, a
certificate rotation or a scheduled job that runs daily."_

It is also explicit that seven days was already a reduction from the thirty ADR 0002 wanted, and
that the reduction was accepted because the strict-parity gate precedes it, the corpus is three
documents, and _"the alternative in practice was not thirty observed days but thirty elapsed
ones."_

The floor cannot begin counting until a host exists (§93.1), and no host has been commissioned.
So the condition has not been delaying a measurement — it has been queued behind one.

## Decision

**The seven-day floor is waived by the owner.** The other three conditions are unchanged and
remain binding: twice-compiled byte-identical output, five action paths exercised, zero
unexplained drift.

## What this gives up, stated plainly

The floor was the only condition that could observe something nobody enumerated. The remaining
three observe exactly what they name, and nothing else. Specifically, cutover may now be accepted
without ever having survived:

- a process restart between compilations;
- a certificate rotation;
- a scheduled job that runs on a daily timer;
- a date boundary of any kind.

ADR 0004 named the first three itself as the reason the floor existed. Removing it does not make
them unlikely to matter; it makes them unobserved.

The mitigation ADR 0004 already relied on still holds — the strict-parity gate precedes cutover
and is the stronger check — and the corpus is still three documents rather than a live changing
estate. What has changed is that the weaker check is now absent rather than merely weak.

## Consequences

- Cutover becomes reachable on the day a host is commissioned rather than a week after.
- If the corpus grows beyond the constitution, ADR 0004 already required the criterion to be
  revisited. That requirement now carries more weight, because one of the four conditions is gone
  and the remaining three do not scale with corpus size.
- A drift that only appears across a restart or a timer will be found in service rather than
  before cutover. That is the trade, and it is the owner's to make.

## Provenance

The waiver is the owner's decision, stated directly. Drafted by an agent under direction per
§103.5, and recorded rather than left in conversation — twice in the preceding week a decision
existed only in the owner's memory and was one conversation away from unrecoverable. Acceptance is
a human act under §94.2.
