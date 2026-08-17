/**
 * The classification-ceiling predicate has exactly one meaning, however it is written.
 *
 * `core.object`'s policies compare a row's classification rank against the caller's ceiling:
 *
 *     (select rank from registry.classification where id = classification)
 *       <= core.current_classification_rank()
 *
 * That is a CORRELATED subquery — it names the row — so PostgreSQL runs it once per row
 * tested. Measured on 36,007 objects it costs ~97 ms of a ~190 ms read
 * (`tests/database/rls-read-cost.test.ts`), which is now the largest single term in the
 * fabric's hottest predicate. An uncorrelated form asks the same question of a table holding
 * a handful of rows and can be hashed once:
 *
 *     classification in (select id from registry.classification
 *                         where rank <= core.current_classification_rank())
 *
 * WHY THIS FILE EXISTS RATHER THAN AN ARGUMENT IN A COMMIT MESSAGE. The term appears in
 * `object_read`'s USING, in `object_write`'s WITH CHECK, and in BOTH halves of
 * `object_update`. It is not only what a caller may see; it is what a caller may write and
 * what a caller may reclassify a record to. A rewrite that is subtly weaker in some corner
 * lets a writer move a record beyond their own ceiling, and no amount of "these are obviously
 * the same" establishes that they are.
 *
 * So equivalence is established BY EXHAUSTION, not by reasoning: every classification the
 * registry defines, crossed with every ceiling a caller can bind — including the ones that
 * are not classifications at all — and the two expressions compared at each point. If the
 * table gains a classification tomorrow, the cross product grows to match, because it is read
 * from the registry rather than written down here.
 *
 * The NULL analysis that makes this tractable, verified against the schema rather than
 * assumed: `registry.classification.rank` is `integer not null unique`, and
 * `core.current_classification_rank()` coalesces a missing setting to `-1`. Neither side of
 * the comparison can be NULL. The only path to a NULL verdict is a row whose classification
 * matches no registry row, and RLS denies on NULL — which the cases below cover explicitly
 * rather than leave to inference.
 */

import { withTransaction } from '@kf/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

/** The shipped form: correlated, evaluated once per row. */
const CORRELATED = `(select rank from registry.classification where id = candidate.classification)
                      <= core.current_classification_rank()`;

/** The candidate form: uncorrelated, hashable once per statement. */
const HASHABLE = `candidate.classification in
                    (select id from registry.classification
                      where rank <= core.current_classification_rank())`;

/**
 * Ceilings a caller can bind that are NOT classifications.
 *
 * `core.set_access_context` takes the ceiling as text and the fabric's model trusts direct
 * connections to bind truthfully, so "truthfully" has to include "wrongly". An empty string
 * and an unset setting both reach the `coalesce(..., -1)`; a plausible-looking unknown value
 * is the one most likely to appear in a misconfigured deployment.
 */
const NON_CLASSIFICATION_CEILINGS = ['', 'not_a_classification', 'RESTRICTED'] as const;

/** Classifications a row can carry that the registry does not define. */
const NON_CLASSIFICATION_ROWS = ['not_a_classification', ''] as const;

let harness: Harness | undefined;
let classifications: readonly string[] = [];

describe('the classification ceiling means the same thing written either way', () => {
  beforeAll(async () => {
    harness = await startHarness();
    const rows = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ id: string }>('select id from registry.classification order by rank'),
    );
    classifications = rows.map((row) => row.id);
    // A cross product over an empty registry would agree at every one of its zero points.
    expect(
      classifications.length,
      'no classifications found, so the exhaustive comparison below has nothing to compare',
    ).toBeGreaterThan(1);
  }, 300_000);

  afterAll(async () => {
    await harness?.stop();
  }, 120_000);

  it('agrees at every classification crossed with every ceiling, including invalid ones', async () => {
    const rowValues = [...classifications, ...NON_CLASSIFICATION_ROWS];
    const ceilings = [...classifications, ...NON_CLASSIFICATION_CEILINGS];
    /** Points where the two forms reach a DIFFERENT ADMISSION DECISION. Must be empty. */
    const disagreements: string[] = [];
    /**
     * Points where the two forms reach the same decision by different values.
     *
     * These are real and this is where they are: a classification the registry does not
     * define yields NULL from the correlated form (a subquery with no rows) and FALSE from
     * the hashable form (absent from the set). RLS denies on both, so no row's fate changes
     * — and `core.object.classification` is `not null references registry.classification
     * (id)`, so no row can carry such a value in the first place. Collected and asserted to
     * be exactly that set rather than tolerated by a looser comparison, because "they differ
     * only somewhere harmless" is a claim that needs checking, not an aside.
     */
    const valueOnlyDifferences: string[] = [];
    let compared = 0;

    for (const ceiling of ceilings) {
      const verdicts = await withTransaction(harness!.adminPool, async (tx) => {
        await tx.query('select set_config($1, $2, true)', ['kf.max_classification', ceiling]);
        return tx.query<{
          classification: string;
          correlated: boolean | null;
          hashable: boolean | null;
        }>(
          `select candidate.classification,
                  (${CORRELATED}) as correlated,
                  (${HASHABLE}) as hashable
             from unnest($1::text[]) as candidate(classification)`,
          [rowValues],
        );
      });

      for (const verdict of verdicts) {
        compared += 1;
        // RLS admits a row when the policy expression is TRUE and denies on FALSE *or NULL*,
        // so the property that matters is agreement after that collapse. The raw values are
        // compared too, since a difference there would mean the two forms disagree about
        // whether the question is even answerable, which is worth knowing even when the
        // admitted set is identical.
        const admitsCorrelated = verdict.correlated === true;
        const admitsHashable = verdict.hashable === true;
        const where = `ceiling=${JSON.stringify(ceiling)} classification=${JSON.stringify(
          verdict.classification,
        )}: correlated=${String(verdict.correlated)} hashable=${String(verdict.hashable)}`;
        if (admitsCorrelated !== admitsHashable) disagreements.push(where);
        else if (verdict.correlated !== verdict.hashable) valueOnlyDifferences.push(where);
      }
    }

    expect(
      disagreements,
      'the two forms of the classification ceiling admit different rows, so they are not ' +
        'interchangeable and the hashable form must not replace the shipped one',
    ).toEqual([]);

    // Every value-level difference is a classification the registry does not define, and at
    // every one of them BOTH forms deny. Asserted as an exact set: a difference appearing at
    // a classification the registry DOES define would be a real divergence wearing the same
    // clothes, and a looser check would wave it through.
    const registered = new Set(classifications);
    const unexpected = valueOnlyDifferences.filter((entry) =>
      [...registered].some((id) => entry.includes(`classification=${JSON.stringify(id)}:`)),
    );
    expect(
      unexpected,
      'the two forms differ in value at a classification the registry defines, which is a ' +
        'reachable row and not the benign unreachable corner',
    ).toEqual([]);
    expect(
      valueOnlyDifferences.length,
      'expected NULL-vs-false only at the classifications no registry row defines, once per ceiling',
    ).toBe(NON_CLASSIFICATION_ROWS.length * ceilings.length);
    for (const entry of valueOnlyDifferences) {
      expect(entry, 'a value-level difference that is not the expected NULL-vs-false').toContain(
        'correlated=null hashable=false',
      );
    }

    // Guards against a loop that silently compared nothing.
    expect(compared).toBe(rowValues.length * ceilings.length);
  }, 300_000);

  it('cannot store a classification the registry does not define', async () => {
    // The corner above is benign because it is unreachable, and unreachable is a property of
    // the schema rather than of anybody's intention. If this constraint were ever relaxed,
    // the NULL-vs-false difference would become reachable — still deny-on-both, but it would
    // no longer be true that no row can take that path, and the reasoning above would need
    // redoing rather than quietly continuing to be cited.
    const constraint = await withTransaction(harness!.adminPool, (tx) =>
      tx.one<{ notnull: boolean; references: string }>(
        `select attribute.attnotnull as notnull,
                coalesce((select confrelid::regclass::text
                            from pg_constraint
                           where conrelid = 'core.object'::regclass
                             and contype = 'f'
                             and attribute.attnum = any (conkey)), 'none') as references
           from pg_attribute attribute
          where attribute.attrelid = 'core.object'::regclass
            and attribute.attname = 'classification'`,
      ),
    );
    expect(constraint.notnull, 'core.object.classification became nullable').toBe(true);
    expect(
      constraint.references,
      'core.object.classification no longer references the classification registry',
    ).toBe('registry.classification');
  }, 120_000);

  it('agrees when the ceiling setting is absent entirely, not merely empty', async () => {
    // `set_config(..., '')` and never having set it at all reach `coalesce(..., -1)` by
    // different routes — `current_setting(..., true)` returns '' in one case and NULL in the
    // other, and `nullif` only collapses the first. A fresh transaction that binds nothing is
    // the only way to exercise the second, and it is the state every connection starts in.
    const verdicts = await withTransaction(harness!.adminPool, (tx) =>
      tx.query<{ classification: string; correlated: boolean | null; hashable: boolean | null }>(
        `select candidate.classification,
                (${CORRELATED}) as correlated,
                (${HASHABLE}) as hashable
           from unnest($1::text[]) as candidate(classification)`,
        [[...classifications, ...NON_CLASSIFICATION_ROWS]],
      ),
    );

    expect(verdicts.length).toBeGreaterThan(0);
    for (const verdict of verdicts) {
      // Admission decision, which is what RLS acts on. The NULL-vs-false difference on
      // registry-absent classifications is characterised exhaustively in the test above; here
      // the property under test is that an unbound ceiling denies, either way.
      expect(
        verdict.hashable === true,
        `unbound ceiling, classification=${verdict.classification}: the two forms disagree`,
      ).toBe(verdict.correlated === true);
    }
    // With no ceiling bound the rank is -1, and every real classification ranks at or above
    // 0, so nothing is admitted. Asserted because "they agree" is also true of two
    // expressions that both wrongly admit everything.
    expect(
      verdicts.filter((verdict) => verdict.correlated === true),
      'an unbound ceiling admitted rows, which is the fail-open this default exists to prevent',
    ).toEqual([]);
  }, 120_000);
});
