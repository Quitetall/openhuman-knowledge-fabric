/**
 * No policy evaluates a row-independent predicate once per row.
 *
 * `content.document_basis_classifier_active()` and `content.compiler_runtime_active()` ask
 * whether a runtime is active. Neither looks at the row being tested, so both have one answer
 * per statement — but written bare in a policy, PostgreSQL calls them for every row it tests.
 * Measured on 36,007 objects, that turned a 94 ms read into a 461 ms read
 * (`tests/database/rls-read-cost.test.ts`), and the rows most affected are the ones the
 * scoped policy is rejecting, because a failing OR branch is what sends a row on to the next.
 *
 * `20260817000100_hoist_row_independent_policy_predicates.sql` wrapped all 30 in
 * `(select ...)` so the planner lifts them into an InitPlan. This asserts the property holds
 * for whatever is installed NOW, rather than trusting that the migration ran and that nobody
 * has since added a thirty-first policy in the old shape — which is the normal way to add
 * one, since the bare form is what reads naturally.
 *
 * It deliberately checks the INSTALLED policies via `pg_policies` rather than grepping the
 * migration files. A policy is whatever the database ended up with after every migration in
 * order, and the file that created it is not necessarily the file that last altered it.
 */

import { withTransaction } from '@kf/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

/**
 * Predicates that depend on nothing about the row.
 *
 * Extend this when another zero-argument gate is introduced. A predicate that reads the row
 * does NOT belong here: wrapping a correlated expression in a subquery is still correct, but
 * it becomes a per-row SubPlan rather than a once-per-statement InitPlan, so the wrapping
 * buys nothing and obscures the intent.
 */
const ROW_INDEPENDENT = ['document_basis_classifier_active', 'compiler_runtime_active'] as const;

let harness: Harness | undefined;

describe('row-independent policy predicates are evaluated once per statement', () => {
  beforeAll(async () => {
    harness = await startHarness();
  }, 300_000);

  afterAll(async () => {
    await harness?.stop();
  }, 120_000);

  it('wraps every runtime-gate policy so the planner can lift it out of the row loop', async () => {
    const bare = await withTransaction(harness!.adminPool, (tx) =>
      tx.query<{ table: string; policy: string; qual: string }>(
        `select schemaname || '.' || tablename as "table",
                policyname as policy,
                qual
           from pg_policies
          where qual is not null
            and qual ~ $1
          order by 1, 2`,
        // A bare call: the whole predicate is the function, with no SELECT lifting it out.
        [`^\\(?\\s*(content\\.)?(${ROW_INDEPENDENT.join('|')})\\(\\)\\s*\\)?$`],
      ),
    );

    expect(
      bare.map((row) => `${row.table}.${row.policy}`),
      'these policies call a row-independent function bare, so PostgreSQL evaluates it once ' +
        'per row tested rather than once per statement. Wrap it: using ((select fn())). ' +
        'Measured cost of not doing so: 94 ms -> 461 ms on 36k rows.',
    ).toEqual([]);
  }, 120_000);

  it('still has the policies it is asserting about, so the check cannot pass vacuously', async () => {
    // The assertion above is satisfied by a database with no such policies at all, which is
    // exactly what a broken migration or a renamed function would produce. Count the hoisted
    // form and require the number the migration reported rewriting.
    const hoisted = await withTransaction(harness!.adminPool, (tx) =>
      tx.query<{ table: string; policy: string }>(
        `select schemaname || '.' || tablename as "table", policyname as policy
           from pg_policies
          where qual is not null
            and qual ~ $1
          order by 1, 2`,
        [`SELECT\\s+(content\\.)?(${ROW_INDEPENDENT.join('|')})\\(\\)`],
      ),
    );
    expect(
      hoisted.length,
      'no policy uses the hoisted form, so the check above is passing because there is ' +
        'nothing to check — the functions have been renamed or the migration did not run',
    ).toBe(30);
  }, 120_000);
});
