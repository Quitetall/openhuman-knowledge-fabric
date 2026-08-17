/**
 * The ceiling sweep changed the ceiling and nothing else.
 *
 * `20260817000300_hashable_classification_ceiling_remaining.sql` restates 15 policies by hand
 * — 19 clauses across 10 tables — to replace a correlated classification-ceiling subquery
 * with an uncorrelated one. Whether the two ceiling forms mean the same thing is settled
 * exhaustively in `classification-predicate-equivalence.test.ts`. This file settles a
 * different and less glamorous question that no equivalence test can reach: whether the
 * TRANSCRIPTION was faithful.
 *
 * Six of those policies govern writes. Four are FOR ALL and carry the ceiling in both USING
 * and WITH CHECK. One carries it inside one arm of an OR. A dropped conjunct, an `and` that
 * became an `or`, a missing `exists`, a mistyped alias — any of those is a real security
 * regression, it is invisible to every other test in this repository, and it is exactly the
 * failure mode of rewriting fifteen predicates by hand.
 *
 * So it is checked mechanically rather than by reading carefully. Two databases are built
 * from the same migration list, one WITH the sweep and one WITHOUT it. Every policy
 * expression is read back from `pg_policies`, the ceiling term — in whichever form that
 * database has it — is replaced by a marker naming the column it bounds, and the results must
 * be byte-identical.
 *
 * Anything the sweep touched other than the ceiling shows up as a difference. Anything it
 * touched that it should not have shows up as a difference. Reordering, requoting, a lost
 * conjunct: all differences.
 *
 * Comparing against a database built without the migration, rather than against the migration
 * reversed, is deliberate. Applying and then reversing tests the reversal — which is one of
 * the things under suspicion — and would agree with itself even if both halves were wrong in
 * the same way.
 */

import { withTransaction } from '@kf/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const SWEEP = '20260817000300_hashable_classification_ceiling_remaining.sql';

/** Policies the sweep restates, as `schema.table.policy`. */
const RESTATED = [
  'content.adr_decision_body.adr_decision_body_read',
  'content.adr_decision_body.adr_decision_body_insert',
  'content.authored_fragment_revision.authored_fragment_revision_scope',
  'content.compilation_basis.compilation_basis_read',
  'content.compilation_basis.compilation_basis_finalize',
  'content.compilation_run.compilation_run_scope',
  'content.compiled_view.compiled_view_scope',
  'content.document_publication.document_publication_scope',
  'ml.aggregate_reference.aggregate_reference_read',
  'ml.aggregate_reference.aggregate_reference_insert',
  'search.document.search_document_read',
  'secure_object.capability_request.capability_request_read',
  'secure_object.capability_request.capability_request_insert',
  'secure_object.erasure_request.erasure_request_read',
  'secure_object.erasure_request.erasure_request_insert',
] as const;

/**
 * Replace whichever ceiling form is present with `«CEILING(column)»`.
 *
 * Both forms name the column they bound, and the column is part of what must not change, so
 * it is kept inside the marker rather than erased with the rest. `classification` becoming
 * `classification_id` in some policy would then still read as a difference.
 */
function normalizeCeiling(expression: string | null, table: string): string | null {
  if (expression === null) return null;
  /**
   * Drop the policy's OWN table qualifier from the bounded column, and only that.
   *
   * The same column renders differently in the two forms, for a reason that is syntax rather
   * than meaning: in the correlated form it sits inside a subquery, so PostgreSQL qualifies
   * it as an outer reference — `compilation_run.effective_classification` — while as the left
   * operand of `IN` it is a plain column reference and renders bare.
   *
   * Only the policy's own table is stripped. `content.adr_decision_body`'s ceiling bounds
   * `decision.classification`, where `decision` aliases `core.object` inside an EXISTS — a
   * different table's column, and collapsing that would hide a rewrite that started bounding
   * the wrong row.
   */
  const unqualify = (column: string): string =>
    column.startsWith(`${table}.`) ? column.slice(table.length + 1) : column;
  return (
    expression
      // Correlated. The alias varies because the defining migrations vary: the `content.*`
      // policies wrote `registry.classification c` and read back as `SELECT c.rank`, the
      // others wrote no alias and read back as `SELECT classification.rank`. A pattern fixed
      // to one of them silently fails to normalise the other, which then reads as a
      // transcription difference — this check reported eleven of those before the alias was
      // allowed to vary, and every one was the test being wrong.
      //
      //   (( SELECT <a>.rank FROM registry.classification [<a>]
      //      WHERE (<a>.id = <column>)) <= core.current_classification_rank())
      .replace(
        /\(\(\s*SELECT (\w+)\.rank\s+FROM registry\.classification(?:\s+\w+)?\s+WHERE \(\1\.id = ([^)]+)\)\)\s*<= core\.current_classification_rank\(\)\)/g,
        (_match, _alias: string, column: string) => `«CEILING(${unqualify(column.trim())})»`,
      )
      // Hashable:
      //   (<column> IN ( SELECT <a>.id FROM registry.classification [<a>]
      //     WHERE (<a>.rank <= core.current_classification_rank())))
      .replace(
        /\(([A-Za-z0-9_.]+) IN \(\s*SELECT (\w+)\.id\s+FROM registry\.classification(?:\s+\w+)?\s+WHERE \(\2\.rank <= core\.current_classification_rank\(\)\)\)\)/g,
        (_match, column: string) => `«CEILING(${unqualify(column.trim())})»`,
      )
  );
}

async function policyText(
  harness: Harness,
): Promise<ReadonlyMap<string, { qual: string | null; withCheck: string | null }>> {
  const rows = await withTransaction(harness.adminPool, (tx) =>
    tx.query<{ key: string; table: string; qual: string | null; with_check: string | null }>(
      `select schemaname || '.' || tablename || '.' || policyname as key,
              tablename as "table", qual, with_check
         from pg_policies
        order by 1`,
    ),
  );
  return new Map(
    rows.map((row) => [
      row.key,
      {
        qual: normalizeCeiling(row.qual, row.table),
        withCheck: normalizeCeiling(row.with_check, row.table),
      },
    ]),
  );
}

let withSweep: Harness | undefined;
let withoutSweep: Harness | undefined;

describe('the ceiling sweep is a faithful transcription', () => {
  beforeAll(async () => {
    [withSweep, withoutSweep] = await Promise.all([
      startHarness(),
      startHarness({ skipMigrations: new Set([SWEEP]) }),
    ]);
  }, 900_000);

  afterAll(async () => {
    await Promise.all([withSweep?.stop(), withoutSweep?.stop()]);
  }, 300_000);

  it('leaves every policy expression identical once the ceiling itself is set aside', async () => {
    const after = await policyText(withSweep!);
    const before = await policyText(withoutSweep!);

    expect(
      [...after.keys()].sort(),
      'the sweep added or removed a policy, which it has no business doing',
    ).toEqual([...before.keys()].sort());

    const differences: string[] = [];
    for (const [key, beforeText] of before) {
      const afterText = after.get(key)!;
      if (beforeText.qual !== afterText.qual) {
        differences.push(
          `${key} USING:\n  before: ${beforeText.qual}\n  after:  ${afterText.qual}`,
        );
      }
      if (beforeText.withCheck !== afterText.withCheck) {
        differences.push(
          `${key} WITH CHECK:\n  before: ${beforeText.withCheck}\n  after:  ${afterText.withCheck}`,
        );
      }
    }

    expect(
      differences,
      'the sweep changed something other than the classification ceiling. Fifteen policies ' +
        'were restated by hand and six of them govern writes, so a difference here is a ' +
        'dropped conjunct or a changed operator in a security rule, not a formatting nit',
    ).toEqual([]);
  }, 300_000);

  it('actually rewrote the ceiling in every policy it claims to, and only those', async () => {
    // The check above passes trivially if the sweep did nothing at all: normalising the
    // ceiling out of both sides hides whether either side ever had one. So the raw text is
    // examined too — every restated policy must have moved from the correlated form to the
    // hashable one, and no policy outside the list may have moved at all.
    const raw = async (harness: Harness): Promise<ReadonlyMap<string, string>> => {
      const rows = await withTransaction(harness.adminPool, (tx) =>
        tx.query<{ key: string; both: string }>(
          `select schemaname || '.' || tablename || '.' || policyname as key,
                  coalesce(qual, '') || ' ~~ ' || coalesce(with_check, '') as both
             from pg_policies order by 1`,
        ),
      );
      return new Map(rows.map((row) => [row.key, row.both]));
    };
    const after = await raw(withSweep!);
    const before = await raw(withoutSweep!);

    const changed = [...before.keys()].filter((key) => before.get(key) !== after.get(key)).sort();
    expect(
      changed,
      'the set of policies the sweep actually changed is not the set it says it changes',
    ).toEqual([...RESTATED].sort());

    for (const key of RESTATED) {
      // `SELECT <alias>.rank`, not a fixed alias: the defining migrations differ on whether
      // they aliased `registry.classification`, and pinning one alias here would assert that
      // half of these policies never had a ceiling at all.
      expect(before.get(key), `${key} did not carry the per-row ceiling before the sweep`).toMatch(
        /SELECT \w+\.rank\s+FROM registry\.classification/,
      );
      expect(after.get(key), `${key} does not carry the hashed ceiling after the sweep`).toMatch(
        /IN \(\s*SELECT classification\.id/,
      );
    }
  }, 300_000);
});
