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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTransaction } from '@kf/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const MIGRATION = join(
  import.meta.dirname,
  '..',
  '..',
  'database',
  'migrations',
  '20260817000100_hoist_row_independent_policy_predicates.sql',
);

/** The `-- migrate:up` or `-- migrate:down` half of a dbmate migration. */
function section(which: 'up' | 'down'): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const up = sql.indexOf('-- migrate:up');
  const down = sql.indexOf('-- migrate:down');
  expect(up, 'migration has no up section').toBeGreaterThanOrEqual(0);
  expect(down, 'migration has no down section').toBeGreaterThan(up);
  return which === 'up'
    ? sql.slice(up + '-- migrate:up'.length, down)
    : sql.slice(down + '-- migrate:down'.length);
}

/** How many installed policies use each form. */
async function shapeCounts(
  harness: Harness,
): Promise<{ readonly bare: number; readonly hoisted: number }> {
  const names = ROW_INDEPENDENT.join('|');
  return withTransaction(harness.adminPool, async (tx) => {
    const bare = await tx.one<{ count: string }>(
      `select count(*)::text as count from pg_policies
        where qual is not null and qual ~ $1`,
      [`^\\(?\\s*(content\\.)?(${names})\\(\\)\\s*\\)?$`],
    );
    const hoisted = await tx.one<{ count: string }>(
      `select count(*)::text as count from pg_policies
        where qual is not null and qual ~* $1`,
      [`select\\s+(content\\.)?(${names})\\(\\)`],
    );
    return { bare: Number(bare.count), hoisted: Number(hoisted.count) };
  });
}

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
            and qual ~* $1
          order by 1, 2`,
        // Case-insensitive (`~*`). PostgreSQL renders the keyword uppercase today, but a
        // check that fails on casing would report "the migration did not run" when the
        // migration ran fine — a confusing failure in the one assertion whose job is to say
        // clearly why the check above cannot be trusted.
        [`select\\s+(content\\.)?(${ROW_INDEPENDENT.join('|')})\\(\\)`],
      ),
    );
    expect(
      hoisted.length,
      'no policy uses the hoisted form, so the check above is passing because there is ' +
        'nothing to check — the functions have been renamed or the migration did not run',
    ).toBe(30);
  }, 120_000);

  it('reverses and reapplies, so the down section is not write-only', async () => {
    // A down section nobody runs is a down section that does not work, and this one very
    // nearly did not: PostgreSQL does not store the text you write, it stores a parse tree
    // and renders it back with an alias it invents —
    //
    //   using ((select content.compiler_runtime_active()))
    //   reads back as  ( SELECT content.compiler_runtime_active() AS compiler_runtime_active)
    //
    // The first version of the down section matched against the shape as WRITTEN, anchored,
    // with no room for that alias. It would have matched zero policies and reversed nothing,
    // silently, which is the failure a rollback cannot afford. Caught by running it.
    const before = await shapeCounts(harness!);
    expect(before).toEqual({ bare: 0, hoisted: 30 });

    await withTransaction(harness!.adminPool, (tx) => tx.query(section('down')));
    const reversed = await shapeCounts(harness!);
    expect(
      reversed,
      'the down section did not restore the bare form, so this migration cannot be rolled back',
    ).toEqual({ bare: 30, hoisted: 0 });

    await withTransaction(harness!.adminPool, (tx) => tx.query(section('up')));
    const reapplied = await shapeCounts(harness!);
    expect(reapplied, 'reapplying after a rollback did not restore the hoisted form').toEqual(
      before,
    );
  }, 300_000);
});
