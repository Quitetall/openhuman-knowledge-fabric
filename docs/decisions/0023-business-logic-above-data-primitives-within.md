# Business logic sits above the Fabric; dataset and lineage capability, if built, sits inside it

- **Status:** accepted — 2026-09-04; recorded for KF SAS `0.1.0-draft.2` (§8.10, §8.11)
- **Date raised:** 2026-09-04
- **Date decided:** 2026-09-04
- **Decision owner:** technical authority
- **Scope:** where business logic lives relative to the authority boundary, and where dataset,
  transform and lineage capability would live if it is ever built

## The problem

The Knowledge Fabric was compared against Odoo and Palantir Foundry to find out what it does not
have. The lists were long and mostly unsurprising: no accounting engine, no inventory, no CRM, no
forms UI, no bulk import; no pipelines, no transforms, no notebooks, no BI, no distributed
compute.

What the comparison exposed was not the absence of those features. It was that **the two lists
have different answers**, and nothing in the repository said so. A reader of §8's non-goals would
have concluded both were equally out of scope, and would have been half wrong.

## Decision

**Business logic is an application above the Fabric.** Invoicing arithmetic, stock movement,
scheduling, order-to-cash, payroll — computed by callers, reaching the Fabric through the
dispatcher as attributed acts like every other writer. The Fabric holds what happened and who
authorised it. It does not decide what a total should be.

**Dataset, transform and lineage capability, if built, is a core primitive.** Under the same act,
audit, access and provenance model as every other record. Not an application above the boundary,
and not a side path that reaches storage directly.

## Why they differ

Law 1 is the reason, and it cuts both ways.

An accounting engine computes a value from inputs. It is arithmetic with a result, and its result
is checked by re-running it. Putting it inside the authority boundary makes the boundary
answerable for the arithmetic, and the first defect in that arithmetic becomes a defect in the
record rather than in something over it. The boundary should hold facts that were asserted, not
values it derived.

A derivation is different in kind. "This dataset was produced from those datasets by that
transform, at that version, by that actor" is **a fact with an authority**, and it is exactly the
shape of fact this system exists to hold. A derived dataset whose provenance lived outside the
act model would be a second authority for its own history, which Law 1 forbids. Lineage is not
analytics; it is provenance, and provenance is the core's job.

So the test is not "is it big" or "is it a feature". It is: **does it assert what happened, or
does it compute what should be?** The first belongs inside. The second belongs above.

## Consequences

- §8.10 and §8.11 state both, positively rather than as absences, because a non-goal invites the
  reading that a capability is merely missing.
- KF-SAS-RQ-190 and KF-SAS-RQ-191 make them requirements rather than prose.
- Nothing is built. `ml.run_lineage`, with its input, output and parent-model tables, is the
  closest existing thing and is the natural seed.
- §100.17 records a constraint this exposed: the eleven §98 phases are fully used against a hard
  cap of ten, so a data-primitives phase cannot be added without restructuring the ladder.
- KF-SAS-RQ-192 was added in the same revision for an unrelated reason: the deploying
  organization's legal name is compiled into three lines of the dogfood bootstrap, and it should
  be configuration. It closes the application-side half of ADR 0006's seam.

## What this does not decide

- **Whether dataset capability is ever built.** Only where it would live.
- **What a transform is**, how it is expressed, or whether it executes anywhere but a caller.
- **How the phase ladder is restructured** if a twelfth objective is ever needed.

## Provenance of the revision

This ADR exists because the tooling refused a claim made about it. The draft amendment history
asserted the revision was not architecture-changing under §94.3; `war sas propose` derived
`architecture-changing: true` from the §106 diff and required a decision record. The tool was
right and the prose was wrong. Recorded here because a specification whose own governance
catches its author is the governance working.
