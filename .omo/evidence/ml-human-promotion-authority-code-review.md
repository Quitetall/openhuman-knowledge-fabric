# ML Human Promotion Authority Code Review

## Scope

Reviewed the latest bytes for the human-authority ML-promotion lane:
`database/migrations/20260814001700_ml_human_promotion_authority.sql`,
`packages/integration/src/ml.ts`, `packages/integration/src/index.ts`,
`packages/integration/src/ml.test.ts`, `packages/ml-registry/src/database.test.ts`,
`packages/orchestrator/src/index.test.ts`, `ontology/action-types.yaml`,
`ontology/object-types.yaml`, and `tests/conformance/r01-golden.test.ts`.

## Skill-Perspective Check

`remove-ai-slops` and `programming` skills were not available in the advertised skill list
or local skill-name search. I applied the prompt-supplied criteria directly. Result: no
deletion-only tests, prompt-only tests, tautological removal tests, untyped production escape
hatches, speculative abstraction, or needless production parsing/normalization found. The
builder-shape assertions mirror public API contracts and are paired with boundary/database
tests, so they are not standalone false-confidence tests.

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

None.

## Evidence Checked

- `pnpm exec vitest run packages/ml-registry/src/database.test.ts tests/conformance/r01-golden.test.ts packages/orchestrator/src/index.test.ts packages/integration/src/ml.test.ts`:
  4 files passed, 43 tests passed.
- `pnpm ontology:check`: 0 errors, 113 existing warnings, generated current at
  `716e20f4a1b2`.
- `pnpm --filter @kf/integration build`, `pnpm --filter @kf/ml-registry build`,
  `pnpm --filter @kf/orchestrator build`: all passed.
- `pnpm exec prettier --check ...` and `pnpm exec eslint ...` on reviewed TS/YAML
  surfaces: passed.
- `pnpm exec vitest run tests/database/fresh-install.test.ts tests/database/readiness.test.ts`:
  2 files passed, 20 tests passed.
- After concurrent refresh adding same-human coverage:
  `pnpm exec vitest run packages/ml-registry/src/database.test.ts packages/integration/src/ml.test.ts`:
  2 files passed, 24 tests passed; focused Prettier/ESLint rerun passed.

## Residual Risks

- The working tree is heavily dirty outside this lane; this review does not approve unrelated
  changes.
- No full `pnpm test` or full `pnpm build` was run by this reviewer.
- Risk tier remains a typed human/promotion claim bound into the decision tuple; I did not
  find a separate authoritative policy fact from which the database could derive it.

## Verdict

codeQualityStatus: CLEAR

recommendation: APPROVE

reportPath: `.omo/evidence/ml-human-promotion-authority-code-review.md`

blockers: []
