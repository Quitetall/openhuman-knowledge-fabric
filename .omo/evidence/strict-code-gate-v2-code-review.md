# Strict Code Gate V2 Code Review

> **Superseded review snapshot — retained for audit history.** This report evaluated the
> pre-refactor working tree. Its H1 modules were subsequently split into narrow internal
> modules, and its L1 preservation concern now has an executable fail-before-ledger regression.
> Current independent verdict is
> [`final-staged-code-review-code-review.md`](./final-staged-code-review-code-review.md). Original
> findings and verdict remain below unchanged; they are not the current release gate.

Scope: `/mnt/4tb/openhuman-knowledge-fabric` full diff from base `d1bbf23` to worktree HEAD `2234555ee096292a816f164dbd8210d048ddbc73`, including tracked changes and untracked files visible in the checkout.

Target graph note: this checkout does not contain `graphify-out/GRAPH_REPORT.md`. The repeated graphify reminder comes from the LamQuant parent context; `/mnt/4tb/LamQuant/graphify-out/GRAPH_REPORT.md` was checked and is not authority for this repository review.

## Skill Perspective Check

Ran before judging tests and maintainability:

- `programming` skill loaded from `/home/brianklam/.codex/.tmp/marketplaces/sisyphuslabs/plugins/omo/skills/programming/SKILL.md`, including TypeScript data-modeling and error-handling references plus code-smell guidance.
- `remove-ai-slops` skill loaded from `/home/brianklam/.codex/.tmp/marketplaces/sisyphuslabs/plugins/omo/skills/remove-ai-slops/SKILL.md`.

Result: the diff violates both perspectives. The main violation is oversized, non-generated TypeScript modules far beyond the 250 pure-LOC ceiling with no local exemption marker. A secondary low-severity violation is brittle text-substring testing in the preservation config test.

## Verification

- PASS: `pnpm exec tsc --build --noEmit`
- PASS: `pnpm exec vitest run packages/export/src/backup-manifest.test.ts packages/ml-registry/src/index.test.ts`
  - 2 test files, 28 tests.
- Not run: full DB/container/e2e suites. The parent request was read-only/no live mutation, and those suites create database/container state. I inspected the relevant DB and integration tests instead.

## CRITICAL

None.

## HIGH

### H1. Oversized non-generated TypeScript modules violate required maintainability gates

References:

- `/mnt/4tb/openhuman-knowledge-fabric/packages/documents/src/index.ts:1` - 2915 pure LOC, changed from roughly 493.
- `/mnt/4tb/openhuman-knowledge-fabric/packages/export/src/index.ts:1` - 2098 pure LOC, changed from roughly 406.
- `/mnt/4tb/openhuman-knowledge-fabric/apps/api/src/routes/ml.ts:1` - 1062 pure LOC, newly added.
- `/mnt/4tb/openhuman-knowledge-fabric/packages/ml-registry/src/index.ts:1` - 1061 pure LOC, newly added.
- `/mnt/4tb/openhuman-knowledge-fabric/apps/api/src/dogfood.ts:1` - 673 pure LOC, changed from roughly 306.
- `/mnt/4tb/openhuman-knowledge-fabric/apps/web/src/app/ml/runs/[authorityId]/revisions/[revisionId]/page.tsx:1` - 612 pure LOC, changed from roughly 4.
- `/mnt/4tb/openhuman-knowledge-fabric/apps/api/src/routes/documents.ts:1` - 600 pure LOC, changed from roughly 209.
- `/mnt/4tb/openhuman-knowledge-fabric/packages/actions/src/index.ts:1` - 566 pure LOC, changed from roughly 452.
- `/mnt/4tb/openhuman-knowledge-fabric/packages/integration/src/ml.ts:1` - 566 pure LOC, newly added.
- `/mnt/4tb/openhuman-knowledge-fabric/packages/export/src/cli.ts:1` - 473 pure LOC.

Trigger: the diff adds or expands many central modules past the loaded `programming` and `remove-ai-slops` 250 pure-LOC limit. `rg` found no `SIZE_OK`, `no-excuse-ok`, or equivalent exemption in the listed files.

Impact: these files now mix security-sensitive authority checks, backup preservation, import/export plumbing, action integration, API request parsing, UI projection, and route registration in very large modules. That raises regression risk and makes future review of two-human promotion authority and preservation guarantees materially harder. The tests may pass while reviewers miss responsibility coupling or local edits with wide blast radius.

Required fix: split the listed modules by cohesive responsibility, leaving small public barrels where needed. Suggested boundaries include promotion receipts, revocations, alias resolution, lineage/run seals, preservation manifest signing, snapshot sections, import target loading, document action atoms, compiler acceptance/publication, API parsing/projections, and presentational UI components. If any large file must remain, add an explicit, reviewable size exemption with rationale and ownership.

## MEDIUM

None.

## LOW

### L1. Preservation config test mirrors implementation text instead of executable behavior

References:

- `/mnt/4tb/openhuman-knowledge-fabric/tests/backup-restore/preservation-config.test.ts:30`
- `/mnt/4tb/openhuman-knowledge-fabric/tests/backup-restore/preservation-config.test.ts:80`

Trigger: the test reads shell scripts and TypeScript source as strings, then checks exact substrings and ordering such as `verify-backup "$BACKUP"`, `--snapshot="$SNAPSHOT_ID"`, and `{ strictSnapshotToken: args.snapshotToken }`.

Impact: these assertions are brittle under harmless refactors and mostly prove that specific text remains present, not that the backup/restore behavior is enforced. This is a `remove-ai-slops` and `programming` concern, but it is low severity because the diff also contains behavior-oriented tests for manifest verification and backup drills.

Suggested fix: keep only minimal deployment-contract checks for generated/static config text. Move preservation guarantees to executable tests around the CLI/script behavior or to the existing backup drill tests.

## Positive Evidence Reviewed

Backup and preservation hardening:

- `/mnt/4tb/openhuman-knowledge-fabric/packages/export/src/backup-manifest.ts` signs and verifies a closed regular-file set, rejects missing/unlisted/symlinked entries, stages exact verified bytes with exclusive creation, and validates the signed manifest against an external trust store.
- `/mnt/4tb/openhuman-knowledge-fabric/scripts/backup.sh` requires explicit signing key and trust-store inputs, holds a shared repeatable-read snapshot, signs the package, and verifies the result.
- `/mnt/4tb/openhuman-knowledge-fabric/scripts/restore-verify.sh` verifies the root backup before using staged bytes, verifies the staged export, uses owner-only credential files, and avoids using unverified archived keys.
- `/mnt/4tb/openhuman-knowledge-fabric/packages/export/src/backup-manifest.test.ts` covers tampering, untrusted keys, source swaps during staging, missing/unlisted files, symlinks, and large dump streaming. This focused suite passed.

Two-human promotion authority:

- `/mnt/4tb/openhuman-knowledge-fabric/database/migrations/20260814001700_ml_human_promotion_authority.sql` adds mandatory quality authority evidence, typed promotion-authority decisions, dispatcher audit/outbox checks, role and organization checks, and distinct-human enforcement.
- `/mnt/4tb/openhuman-knowledge-fabric/packages/ml-registry/src/index.ts` requires both technical and quality decisions in signed promotion receipts, rejects duplicate decision digests, verifies receipt signatures, and prevents governed alias fallback after revocation.
- `/mnt/4tb/openhuman-knowledge-fabric/packages/ml-registry/src/index.test.ts` covers quality-required receipts for all tiers, cross-organization rejection, org-scoped alias resolution, and no-fallback revocation behavior. This focused suite passed.
- `/mnt/4tb/openhuman-knowledge-fabric/packages/integration/src/ml.test.ts` and `/mnt/4tb/openhuman-knowledge-fabric/packages/ml-registry/src/database.test.ts` contain DB/integration coverage for typed decisions, raw bypass rejection, same-human rejection, required quality evidence, and signature tamper rejection. These were inspected but not executed due the read-only/no-live-mutation constraint.

## Status

codeQualityStatus: BLOCK

recommendation: REQUEST_CHANGES

reportPath: `.omo/evidence/strict-code-gate-v2-code-review.md`

blockers:

- Split or explicitly justify the oversized non-generated TypeScript modules listed in H1. This is a HIGH finding under the required `programming` and `remove-ai-slops` perspectives, so approval is blocked until fixed or a reviewed exemption is added.
