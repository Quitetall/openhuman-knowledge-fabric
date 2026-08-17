<!--
`CONTRIBUTING.md` has the reasoning behind these. The short version is that every one of them
exists because its absence caused a real defect in this repository.
-->

## What changed, and why

## What was measured

<!--
The command and its output, not an adjective. "RLS read cost 514 ms -> 16 ms, `KF_MEASURE_RLS=1
npx vitest run tests/database/rls-read-cost.test.ts`" is the shape. If the change cannot state
what it measured, that usually means it has not been measured — which is fine to say here.
-->

## If this adds or changes a guard: how was it falsified?

<!--
Break the thing it checks, confirm it reports the failure BY NAME, restore. Two guards written in
this repository passed against the case they were written for and were blind to the case that
mattered; both were caught this way and neither would have been caught by review.

Not applicable if the change adds no check.
-->

## What this does NOT cover

<!--
The most useful paragraph in most of the files here. A check that says what it cannot see is
worth more than one that implies it sees everything.
-->

## Checks

- [ ] `pnpm gate` passes locally (not `gate:fast` — that skips the suite and the build)
- [ ] No PHI, no vendor datasheet content, no credentials. Git does not forget, and a reverted
      commit is still a disclosure.
- [ ] If a claim in a document became false, this changes it — and says it was wrong rather than
      quietly improving it.
- [ ] If this touches an authority boundary (row-level security, the action model, signing,
      human-only actions), it says so above and a decision record exists or is not needed.
