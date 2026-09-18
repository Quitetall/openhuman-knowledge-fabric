import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * A reclassification takes effect in the transaction that commits it, not when a worker gets to it.
 *
 * `search.document` denormalises `classification` and the read policy used to evaluate the caller's
 * clearance against THAT COPY. The copy is refreshed through the outbox, whose own documentation
 * says delivery "is allowed to be late" — and late is what broke it, because the copy was
 * authoritative for visibility. Between an act committing and the drain running, the index served
 * the old level over `search.document.body`, which holds the assembled plaintext of every
 * controlled document.
 *
 * These tests reproduce that window deliberately: they reclassify the record and do NOT reindex,
 * which is exactly the state the outbox leaves behind while it is late. The stale row is still
 * there, still carrying the old classification, and must not be readable.
 */
describe('search visibility follows the record, not the index copy', () => {
  let harness: Harness;
  let f: Fixtures;
  let objectId: string;

  beforeAll(async () => {
    harness = await startHarness();
    f = await seedFixtures(harness.adminPool);
    objectId = await createObject(harness.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Supplier qualification, second source',
      createdBy: f.performerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query('select search.index_object($1)', [objectId]);
    });
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  });

  async function visibleAt(ceiling: string): Promise<number> {
    return withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, ceiling]);
      const rows = await tx.query<{ n: string }>(
        'select count(*)::text as n from search.document where object_id = $1',
        [objectId],
      );
      return Number(rows[0]?.n ?? '0');
    });
  }

  /** The staleness is real: the index still says what it said before the act. */
  async function indexedClassification(): Promise<string | undefined> {
    return withTransaction(harness.adminPool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      const rows = await tx.query<{ classification: string }>(
        'select classification from search.document where object_id = $1',
        [objectId],
      );
      return rows[0]?.classification;
    });
  }

  it('indexes the record and serves it at the level it was created with', async () => {
    expect(await indexedClassification()).toBe('internal');
    expect(await visibleAt('internal')).toBe(1);
  });

  it('hides it the moment it is reclassified upward, before any reindex', async () => {
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `update core.object set classification = 'restricted', row_version = row_version + 1 where id = $1`,
        [objectId],
      );
    });

    // The window, reproduced: the index has not been told, and must not be trusted anyway.
    expect(
      await indexedClassification(),
      'the index copy should still be stale — if it is not, this test is no longer reproducing the window it exists for',
    ).toBe('internal');

    expect(
      await visibleAt('internal'),
      'a caller cleared only to internal read a restricted record through the search index, ' +
        'because the policy trusted a denormalised copy a worker had not yet refreshed',
    ).toBe(0);
    expect(await visibleAt('restricted')).toBe(1);
  });

  it('shows it again when it is reclassified downward, also before any reindex', async () => {
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `update core.object set classification = 'public', row_version = row_version + 1 where id = $1`,
        [objectId],
      );
    });
    expect(await indexedClassification()).toBe('internal');
    expect(
      await visibleAt('public'),
      'deferring to the record has to work in both directions, or it is a ratchet rather than a rule',
    ).toBe(1);
  });
});
