/**
 * Search, and the two properties that make it safe to build on.
 *
 * VISIBILITY. The index holds every record, so classification is enforced at query time. A
 * search that returned a restricted title to an internal-only reader would be a disclosure
 * through the back door — the front door being row-level security, which this table does not
 * inherit.
 *
 * DISPOSABILITY. The index is derived. `rebuild()` reconstructs it from the records, and the
 * test below drops every row and proves the result is identical. If that ever stops holding,
 * the index has quietly become a second source of truth — which is the thing the federation
 * boundary exists to prevent, and it would be strange to enforce that against other systems
 * and not ourselves.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { indexObject, rebuild, search } from '@kf/search';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;
let board: string;
let restrictedOrder: string;

const internal = () => ({ organizationId: f.organizationId, maxClassification: 'internal' });
const restricted = () => ({ organizationId: f.organizationId, maxClassification: 'restricted' });

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);

  board = await createObject(h.adminPool, f, {
    type: 'configuration_item',
    domain: 'configuration',
    state: 'proposed',
    title: 'Electrode front-end board',
    createdBy: f.performerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `insert into product.configuration_item
         (id, item_kind, part_number, revision_label, parent_system)
       values ($1, 'hardware', 'CNB-2201', 'B', $1)`,
      [board],
    );
  });

  const nc = await createObject(h.adminPool, f, {
    type: 'nonconformity',
    domain: 'qms',
    state: 'open',
    title: 'Leakage current above specification',
    createdBy: f.performerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `insert into quality.nonconformity (id, severity, detected_on, description)
       values ($1, 'major', now(), 'Patient leakage measured at 14 microamps under single fault.')`,
      [nc],
    );
  });

  // A restricted record, so the visibility test has something real to be refused.
  restrictedOrder = await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    const { version } = await tx.one<{ version: string }>(
      'select version from registry.schema_release where is_current',
    );
    const row = await tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('decision_record','engineering','proposed','restricted','project_record',
               $1,$2,'Contractor day rate for leakage rework',$3,$3)
       returning id`,
      [version, f.organizationId, f.performerId],
    );
    return row.id;
  });

  await withTransaction(h.adminPool, async (tx) => {
    for (const id of [board, nc, restrictedOrder]) await indexObject(tx, id);
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('finding things', () => {
  it('finds a record by what it is about', async () => {
    const hits = await search(h.pool, restricted(), { text: 'leakage current' });
    expect(hits.map((x) => x.title)).toContain('Leakage current above specification');
    expect(hits[0]!.matchedBy).toBe('full_text');
  });

  it('searches the body, not only the title', async () => {
    // "single fault" appears in the description alone.
    const hits = await search(h.pool, restricted(), { text: 'single fault' });
    expect(hits.map((x) => x.title)).toContain('Leakage current above specification');
  });

  it('finds a PARTIAL identifier, which full text cannot do at all', async () => {
    // A tokeniser splits CNB-2201 in ways nobody expects, which is why trigram is here.
    const hits = await search(h.pool, restricted(), { text: 'CNB-22' });
    expect(hits.map((x) => x.objectId)).toContain(board);
    expect(hits.find((x) => x.objectId === board)?.matchedBy).toBe('partial_identifier');
  });

  it('says which path matched, because "why did this come back" is a real question', async () => {
    const hits = await search(h.pool, restricted(), { text: 'leakage' });
    for (const hit of hits) {
      expect(['full_text', 'partial_identifier']).toContain(hit.matchedBy);
    }
  });

  it('ranks a full-text hit above a substring one', async () => {
    const hits = await search(h.pool, restricted(), { text: 'leakage' });
    const first = hits.findIndex((x) => x.matchedBy === 'partial_identifier');
    const lastFullText = hits.map((x) => x.matchedBy).lastIndexOf('full_text');
    if (first >= 0 && lastFullText >= 0) expect(lastFullText).toBeLessThan(first);
  });

  it('filters by type and by state', async () => {
    const hits = await search(h.pool, restricted(), {
      text: 'leakage',
      objectTypes: ['nonconformity'],
    });
    expect(hits.every((x) => x.objectType === 'nonconformity')).toBe(true);

    const none = await search(h.pool, restricted(), {
      text: 'leakage',
      lifecycleStates: ['closed'],
    });
    expect(none).toEqual([]);
  });

  it('returns nothing for an empty query rather than everything', async () => {
    // The failure that turns a search box into an exfiltration tool.
    expect(await search(h.pool, restricted(), { text: '   ' })).toEqual([]);
  });

  it('survives a malformed query instead of raising', async () => {
    // `to_tsquery` raises on a stray operator; `websearch_to_tsquery` does not. A user's typo
    // must not become a 500.
    const hits = await search(h.pool, restricted(), { text: 'leakage & | ! ((' });
    expect(Array.isArray(hits)).toBe(true);
  });
});

describe('visibility', () => {
  it('hides a restricted record from an internal-only reader', async () => {
    const asRestricted = await search(h.pool, restricted(), { text: 'day rate' });
    expect(asRestricted.map((x) => x.objectId)).toContain(restrictedOrder);

    const asInternal = await search(h.pool, internal(), { text: 'day rate' });
    // Not merely redacted — absent. A hit that said "1 result you may not see" would leak
    // the fact that the record exists.
    expect(asInternal.map((x) => x.objectId)).not.toContain(restrictedOrder);
  });

  it('hides everything from another organization', async () => {
    const hits = await search(
      h.pool,
      { organizationId: '01930000-0000-7000-8000-00000000dead', maxClassification: 'restricted' },
      { text: 'leakage' },
    );
    expect(hits).toEqual([]);
  });

  it('a classification the caller does not hold narrows, never widens', async () => {
    // Same query, two clearances, and the lower one is a strict subset.
    const high = await search(h.pool, restricted(), { text: 'leakage' });
    const low = await search(h.pool, internal(), { text: 'leakage' });
    const highIds = new Set(high.map((x) => x.objectId));
    for (const hit of low) expect(highIds).toContain(hit.objectId);
  });
});

describe('the index is derived, and provably disposable', () => {
  it('rebuilds to exactly what was there', async () => {
    const before = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ object_id: string; title: string; body: string }>(
        'select object_id, title, body from search.document order by object_id',
      ),
    );
    expect(before.length).toBeGreaterThan(0);

    // Drop the lot. If this cannot be undone, the index is data.
    await withTransaction(h.adminPool, async (tx) => tx.query('delete from search.document'));
    expect(await search(h.pool, restricted(), { text: 'leakage' })).toEqual([]);

    const count = await rebuild(h.adminPool);
    expect(count).toBeGreaterThan(0);

    const after = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ object_id: string; title: string; body: string }>(
        'select object_id, title, body from search.document order by object_id',
      ),
    );
    // Every row the index held is back, with the same searchable text — and every object in
    // the database is indexed, including ones nobody indexed by hand.
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    const rebuilt = new Map(after.map((r) => [r.object_id, r]));
    for (const row of before) {
      expect(rebuilt.get(row.object_id)?.title).toBe(row.title);
      expect(rebuilt.get(row.object_id)?.body).toBe(row.body);
    }
  });

  it('indexes EVERY object, not only the ones somebody remembered', async () => {
    const counts = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ objects: string; documents: string }>(
        `select (select count(*) from core.object)::text as objects,
                (select count(*) from search.document)::text as documents`,
      ),
    );
    // A subset would be an index that looks complete and is not — the reason text_for runs
    // as SECURITY DEFINER rather than through the caller's own visibility.
    expect(counts.documents).toBe(counts.objects);
  });

  it('re-indexing one object is idempotent', async () => {
    const first = await withTransaction(h.adminPool, async (tx) => {
      await indexObject(tx, board);
      return tx.one<{ body: string }>('select body from search.document where object_id = $1', [
        board,
      ]);
    });
    const second = await withTransaction(h.adminPool, async (tx) => {
      await indexObject(tx, board);
      return tx.one<{ body: string }>('select body from search.document where object_id = $1', [
        board,
      ]);
    });
    expect(second.body).toBe(first.body);
  });
});
