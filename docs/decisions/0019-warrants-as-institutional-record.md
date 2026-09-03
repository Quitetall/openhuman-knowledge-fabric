# A Warrant is an institutional record here and a source record in Git

**Status:** accepted — implemented 2026-09-02; builds on ADR 0018; answers OpenWarrant SAS §67, §12, §24, §28, §83.5, §84
**Date raised:** 2026-09-02
**Date decided:** 2026-09-02
**Decision owner:** technical authority
**Scope:** what Knowledge Fabric holds for an OpenWarrant Warrant, which of §67's thirty-two
actions write what, how the five state dimensions are kept, and what is deliberately not yet
projected

## The problem, measured

OpenWarrant's SAS says "registered WARs use KF as institutional authority while Git may remain
Source Holder" (§98 Phase 4 exit), and OW-WAR-0044 has been blocked on it since 2026-08-23:
KF had no warrant object type, none of §67's actions, and no allocator. The allocator landed
with ADR 0018. This record lands the vocabulary and the record, so that a Warrant can be
registered through real typed actions against a running KF, with the two authorities kept
apart.

## Decision

**One first-class object type, `warrant`, in the `work` schema.** The OpenWarrant UUIDv7
minted at draft creation IS the object id (§12.2: created once, never changes; §12.7: stable
references). `create_warrant_draft` therefore takes `warrant_uuid` and refuses a non-v7 value
and an identity that already exists. The typed row (`work.warrant`) carries the §12.5
federation facts — repository, local alias, profile, assurance level — and four of §24's five
state dimensions as columns: `execution_condition`, `outcome`, `currency`, `standing`. The
fifth, **phase**, is the object's lifecycle state, driven by the registry's `warrant` state
machine exactly along §24.7 (draft → proposed → authorized → ready → executing → verifying →
resolved), with withdrawal back to draft and §24.8's amendment return to authorized. Blocking
and pausing overlay the phase and move only `execution_condition`; a resolution's outcome stays
when standing later becomes `disputed` or `annulled` (§24.6).

**Contract revisions are immutable snapshots (§28).** `work.warrant_contract_revision` holds,
per revision, the contract digest and Compilation Basis as OpenWarrant computed them, the
canonical IR (§83.5's immutable canonical snapshot), the predecessor and structured difference
(§28.6), and — on an authorized revision — authorizer, acting role, meaning, policy basis and
effective time (§28.4). An append-only trigger makes §28.7 structural. KF records; it does not
recompute, because Git is the Source Holder and the authored atoms never enter this database.
Authorization must name the digest it authorizes and is refused when that is not the one
proposed; blocking and pausing are refused outside the phases §24.7 overlays them on; a
superseding successor must itself be current.

**All thirty-two names are owned.** The `warrants` group owns every §67 action, spelled as
OpenWarrant's seam spells them, so a client cannot be refused for a reason that reads like its
mistake. Seventeen write something typed: the eight contract actions, the four condition
actions (open/resolve blocker, pause/resume), and five terminal ones (resolve, dispute, resolve
dispute, annul, supersede, deprecate — supersede also names its successor). Phase transitions
are registry transitions and need no handler.

**What is accepted, audited, and not yet projected.** `record_warrant_preflight`,
`authorize_warrant_dispatch`, `attach_warrant_runtime_receipt`, `register_warrant_submission`,
the three deviation actions, `record_warrant_discovered_gap`, and the six evidence actions
carry their payload into the action record and the audit chain, drive the phase where §24 says,
and write no typed row. §84 lists the records they should project (`warrant_submission`,
`warrant_blocker`, `warrant_deviation`, `warrant_evidence`, `warrant_runtime_receipt_reference`,
…); each is a table with its own constraints and its own act, and lands when its shape is
decided against a real OpenWarrant payload rather than guessed here.

**§67.1–67.4 are the dispatcher's.** The envelope, server-assigned `recorded_at`, optimistic
concurrency on `expected_version`, and payload-equivalent idempotency were already the
kernel's behaviour for every action; the tests here prove them for a Warrant.

## What this does not decide

- ~~Numbering.~~ Decided 2026-09-02: registry 1.0.0-draft.2 allocates `WAR`, so a Warrant is
  numbered `OH-WAR-NNNNNN-C` by `allocate_enterprise_identifier` on any instance seeded from
  that revision. The recorded refusal before it is the contrast §12.4 asked for.
- **Relations.** Superseding names its successor in a column; `supersedes` as a
  `core.relation` and Warrant-to-project links wait for a reader who needs them.
- **§68 round trip.** The preservation export carries both tables; the OpenWarrant-side
  export/import/re-export is OW-WAR-0044's own deliverable.

## How this is held

`tests/database/warrants.test.ts`, against a real database: draft → proposal snapshot →
authorized revision with authorizer, role and server time; the OpenWarrant UUID as identity,
refused twice over; §67.3 drift fails rather than overwrites; §67.4 replay and conflicting
reuse; authorizing a foreign digest is refused and a revision cannot be altered; the allocator
refuses a Warrant naming `WAR`; and a full walk through withdrawal, amendment, blocking,
dispatch, submission, resolution, dispute and annulment moves each dimension and nothing else.
