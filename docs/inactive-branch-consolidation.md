# Inactive branch consolidation — 2026-10-07

Use this record when deciding whether an older KF branch still needs merging.
The owner requested one integrated `main`, excluding active branches. This is
source/history consolidation, not deployment, qualification or ADR acceptance.

## Disposition

| Branch and retained tip                                                              | Disposition on main                                                                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex/ow111-historical-stage-binding` — `e87fd4b76dcc207643e31ccd1a0d789a4e1b7ca2`  | Integrate the historical contract-binding implementation, tests and documentation.                                                         |
| `codex/ow111-source-complete-roundtrip` — `bcb7accc5071065a7cb2ce3b87eedb35eeaed922` | Retain ancestry; its patch already landed as `2bbcbaf6`. Preserve the newer populated-runtime and two-fixture tests.                       |
| `codex/lamu-context-source` — `09fcce98c94c06b20c427e461d70c9e95982b6f0`             | Retain the prototype and paired-probe history without reactivating its superseded API. Keep the current source routes and authority model. |
| `codex/lamu-runtime-contract` — `68edc5fb9e3b6c43a45cf316c90abbdfc5d97cf7`           | Retain proposal/history without replacing the current SAS, ADRs, revision records or generated projections.                                |

The OpenWarrant change binds a reconstructed historical declaration only to its
exact contract revision/digest and retained snapshot location. Null bindings do
not fall back to current-contract matching. Equivalent repeated snapshots retain
their source pointers; conflicting graphs remain ambiguous. Source authentication
and execution qualification remain separate, as described in the
[preservation interface](integrations/openwarrant-preservation.md#reconstructed-historical-stage-bindings).

## Why the old LAMU branches are history, not a second runtime

The September prototype supplies generic canonical facts through an earlier
verifier/options interface. Main now serves the current retrieve/read/revision
contract through live attested principals, agent-context membership, object-store
text and recorded disclosures/refusals. Its implementation and coverage are
`apps/api/src/routes/context-source.ts`,
`apps/api/src/routes/context-source/record.ts` and
`tests/database/context-source.test.ts`; the [SAS](sas/KF_Software_Architecture_Specification.md)
§64C is the current contract. Adding the prototype alongside these would create
a competing route/authority path, not finish a missing production integration.

The old proposal calls itself ADR 0032, but that identifier is now assigned to
[the seven-day-floor waiver](decisions/atoms/KF-ADR-0032-the-seven-day-floor-is-waived.md).
It also proposes a different draft.5 SAS candidate. Neither collision authorizes
overwriting current governed records or allocating a replacement identifier.
Its architecture discussion remains a historical proposal, not an accepted ADR.

The original source and tests remain accessible from main's merged history:

```sh
git show 09fcce98:tests/database/context-source.test.ts
git show 09fcce98:packages/documents/src/context-source.ts
git show 68edc5fb:docs/decisions/0032-lamu-runtime-source-contract.md
git show 68edc5fb:docs/research/lamu-source-contract-checks.md
```

The historical paired LAMU probes, socket cancellation experiment and cleanup
regressions are preserved experiments, not newly ported or qualified current
features. A future port must use the current contracts and evidence rules. This
consolidation does not claim those old probes pass against today's runtime.

## Active work deliberately excluded

At the consolidation check, hosting work had live processes and the SeaweedFS
checkout contained an untracked migration helper. Preserve these branches and
worktrees for separate integration:

- `harden/defensive-posture`, including the proposed ADR 0039 shared by hosting.
- `host/offsite-tailnet`.
- `host/seaweedfs`, including its uncommitted files.

Branch age alone is not inactivity. Recheck worktree state, current process
ownership and branch tips before a later integration. Do not stop shared
services, reset a writer's checkout or treat the proposed topology as accepted.

## Verify consolidation

Each inactive tip above must be an ancestor of `origin/main`; check with
`git merge-base --is-ancestor <tip> origin/main`. Reachability preserves the exact
historical files even when a history-only merge keeps the newer main tree.
`git branch --no-merged origin/main` should show only intentionally excluded
work from this set. Branch references are retained; no branch or worktree is
deleted as part of consolidation.

Run the repository gate and the CI-pinned full-history secret scan before
publishing. Compare the current SAS/ADR, LAMU routes and database interfaces
against baseline `067bd0bb` to verify that the superseded candidates did not
replace them. A green source gate still does not promote the VM or discharge
owner-controlled custody and acceptance work.

Include merge-authored changes in the local history scan by passing
`--log-opts='--all --full-history --diff-merges=first-parent'` to the CI-pinned
gitleaks binary. A plain patch log can omit new content authored in a merge.

## Existing CI authority blocker

[CI for baseline 067bd0bb](https://github.com/Quitetall/openhuman-knowledge-fabric/actions/runs/37574549531)
passed build, tests, ontology and secret scanning. The separate SAS job failed
`authority.actor-not-human` for accepted revision draft.8: Brian Lam has no
SSH principal declaration in `docs/authority/roles.toml`. The generated-view
comparisons passed. Branch consolidation neither supplies that human identity
declaration nor waives its check, and the current authority files are preserved.
