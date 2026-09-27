/**
 * Search, and the two properties that make it safe to build on.
 *
 * VISIBILITY. The index holds every record, so a search that returned a restricted title to an
 * internal-only reader would be a disclosure through the back door. Enforced in two places:
 * the query applies the organization and classification predicate, and `search.document`
 * carries row-level security on the same two axes. It did not until
 * `20260816000100_search_visibility_boundary.sql` — and query-time enforcement reaches only
 * callers who come through `@kf/search`, which kf_readonly and kf_auditor, holding `select` on
 * the table and connecting directly, do not.
 *
 * DISPOSABILITY. The index is derived. `rebuild()` reconstructs it from the records, and the
 * test below drops every row and proves the result is identical. If that ever stops holding,
 * the index has quietly become a second source of truth — which is the thing the federation
 * boundary exists to prevent, and it would be strange to enforce that against other systems
 * and not ourselves.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms } from '@kf/documents';
import { UNVERIFIED_LABEL } from '@kf/domain';
import { createFabricDispatcher } from '@kf/orchestrator';
import { indexObject, rebuild, search } from '@kf/search';
import {
  bindContext,
  bindReader,
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
let percentLiteral: string;
let percentWildcardNeighbour: string;
let underscoreLiteral: string;
let underscoreWildcardNeighbour: string;
let frenchPorosity: string;
let phraseInOrder: string;
let phraseApart: string;

// A search runs as a principal (20260923000100): a person under a live assignment, whose
// clearance the database clamps the requested ceiling to.
const asPerformer = (maxClassification: string) => ({
  actorId: f.performerId,
  actingRoleId: f.performerRoleId,
  organizationId: f.organizationId,
  maxClassification,
});
const internal = () => asPerformer('internal');
const restricted = () => asPerformer('restricted');

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

  percentLiteral = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title: 'Literal identifier ZX%Q',
    createdBy: f.performerId,
  });
  percentWildcardNeighbour = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title: 'Wildcard neighbour ZXXQ',
    createdBy: f.performerId,
  });
  underscoreLiteral = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title: 'Literal identifier LOT_A7',
    createdBy: f.performerId,
  });
  underscoreWildcardNeighbour = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title: 'Wildcard neighbour LOTXA7',
    createdBy: f.performerId,
  });

  // A French record, indexed in French (20260926100000): its words are French stems, and a French
  // query finds them through the French stems of its own words.
  frenchPorosity = await createObject(h.adminPool, f, {
    type: 'nonconformity',
    domain: 'qms',
    state: 'open',
    title: 'Porosités sur les carters du lot 2024-0312',
    createdBy: f.performerId,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `insert into quality.nonconformity (id, severity, detected_on, description)
       values ($1, 'major', now(), 'Les porosités constatées sur les carters sont dues à une ' ||
               'mauvaise maîtrise de la température de coulée, et le lot est bloqué.')`,
      [frenchPorosity],
    );
  });
  phraseInOrder = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title: 'Torque wrench calibration interval',
    createdBy: f.performerId,
  });
  phraseApart = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title: 'Calibration of the wrench used for torque interval checks',
    createdBy: f.performerId,
  });

  await withTransaction(h.adminPool, async (tx) => {
    for (const id of [
      frenchPorosity,
      phraseInOrder,
      phraseApart,
      board,
      nc,
      restrictedOrder,
      percentLiteral,
      percentWildcardNeighbour,
      underscoreLiteral,
      underscoreWildcardNeighbour,
    ]) {
      await indexObject(tx, id);
    }
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

  it.each([
    ['%', () => percentLiteral, () => percentWildcardNeighbour],
    ['LOT_A7', () => underscoreLiteral, () => underscoreWildcardNeighbour],
  ])(
    'treats SQL wildcard characters in %s as literal search text',
    async (text, exact, neighbour) => {
      const hits = await search(h.pool, restricted(), { text });
      expect(hits.map((hit) => hit.objectId)).toContain(exact());
      expect(hits.map((hit) => hit.objectId)).not.toContain(neighbour());
    },
  );
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
    // A real second organization with a real person in it: the application can no longer bind
    // an organization nobody belongs to, so the reader there has to exist to ask at all.
    const other = await seedFixtures(h.adminPool, { auditClearance: false });
    const hits = await search(
      h.pool,
      {
        actorId: other.performerId,
        actingRoleId: other.performerRoleId,
        organizationId: other.organizationId,
        maxClassification: 'restricted',
      },
      { text: 'leakage' },
    );
    expect(hits).toEqual([]);
    // And an organization the caller does not belong to is refused, not answered empty.
    await expect(
      search(
        h.pool,
        { ...restricted(), organizationId: other.organizationId },
        { text: 'leakage' },
      ),
    ).rejects.toThrow(/not held live/);
  });

  it('a classification the caller does not hold narrows, never widens', async () => {
    // Same query, two clearances, and the lower one is a strict subset.
    const high = await search(h.pool, restricted(), { text: 'leakage' });
    const low = await search(h.pool, internal(), { text: 'leakage' });
    const highIds = new Set(high.map((x) => x.objectId));
    for (const hit of low) expect(highIds).toContain(hit.objectId);
  });
});

describe('a question finds what it is about, in the record’s own language (20260926100000)', () => {
  it('matches a sentence as typed without requiring every word', async () => {
    // "much" is in no record. Every word used to be required.
    const hits = await search(h.pool, restricted(), {
      text: 'How much leakage was measured under single fault?',
    });
    expect(hits.map((x) => x.title)).toContain('Leakage current above specification');
  });

  it('refuses a flood: a record holding less than half of what the query says is not a match', async () => {
    // "leakage" is in two records; the other four words are in none. Under any-word matching
    // both would be matches; the floor finds that neither holds half the query's information.
    expect(
      await search(h.pool, restricted(), { text: 'leakage quokka platypus wombat zebu' }),
    ).toEqual([]);
    // The same word alone is a full match.
    expect((await search(h.pool, restricted(), { text: 'leakage' })).map((x) => x.title)).toContain(
      'Leakage current above specification',
    );
  });

  it('puts the records holding every word, and the phrase as typed, first', async () => {
    const hits = await search(h.pool, restricted(), { text: 'torque wrench calibration' });
    const ids = hits.map((x) => x.objectId);
    expect(ids.slice(0, 2).sort()).toEqual([phraseInOrder, phraseApart].sort());
    expect(ids[0], 'the words in the order typed rank first').toBe(phraseInOrder);
    expect(hits[0]!.rank).toBe(1);
  });

  it('indexes a French record in French and finds it by a French query and its stems', async () => {
    const languages = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ languages: string }>(
        'select languages::text as languages from search.document where object_id = $1',
        [frenchPorosity],
      ),
    );
    expect(languages.languages).toBe('{french}');
    // "bloquant" where the record has "bloqué": only a French stemmer joins them. English
    // stemming, which every record had, does not.
    const hits = await search(h.pool, restricted(), { text: 'porosité bloquant' });
    expect(hits.map((x) => x.objectId)).toContain(frenchPorosity);
    const english = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ found: boolean }>(
        `select to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', 'bloquant')
                  as found
           from search.document where object_id = $1`,
        [frenchPorosity],
      ),
    );
    expect(english.found, 'the probe: English stemming alone would not have found it').toBe(false);
  });

  it('finds term hits only in the bound caller’s own scope, and none for an unbound session', async () => {
    const hits = (tx: Parameters<Parameters<typeof withTransaction>[1]>[0]) =>
      tx.query<{ object_id: string }>(
        `select object_id from search.term_hits(array[to_tsquery('english', 'contractor')], null, null, null)`,
      );
    // search.term_hits is a definer seam; its scope comes from the sealed context and nothing else.
    expect(await withTransaction(h.pool, hits)).toEqual([]);
    const asRestricted = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId, 'restricted');
      return hits(tx);
    });
    expect(asRestricted.map((r) => r.object_id)).toContain(restrictedOrder);
    const asInternal = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId, 'internal');
      return hits(tx);
    });
    expect(asInternal.map((r) => r.object_id)).not.toContain(restrictedOrder);
  });

  it('keeps an English record English and a title with no language as it was', async () => {
    const rows = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ object_id: string; languages: string }>(
        'select object_id, languages::text as languages from search.document where object_id = any($1)',
        [[board, percentLiteral]],
      ),
    );
    expect(rows.map((r) => r.languages)).toEqual(['{english}', '{english}']);
  });
});

describe('the index is derived, and provably disposable', () => {
  it('rebuilds in batches, and a stopped rebuild resumes where it stopped', async () => {
    const total = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ n: string }>('select count(*)::text as n from core.object'),
    );
    const seen: { indexed: number; last: string }[] = [];
    const first = await rebuild(h.adminPool, { batchSize: 7, onBatch: (p) => seen.push(p) });
    expect(first).toBe(Number(total.n));
    expect(seen.length).toBeGreaterThan(1);
    // Resume from the third batch's last record: exactly the remainder is indexed.
    const resumed = await rebuild(h.adminPool, { batchSize: 7, after: seen[2]!.last });
    expect(resumed).toBe(Number(total.n) - seen[2]!.indexed);
    // The batch seam is the worker's, like rebuild(): not the application's.
    await expect(
      withTransaction(h.pool, async (tx) =>
        tx.query('select * from search.rebuild_batch(null, 10)'),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

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

  it('refuses the whole index and the definer text assemblers to an unbound application session', async () => {
    // `h.pool` logs in as kf_app_login, which inherits kf_app and is not the table owner —
    // the shape a deployed API process has. No access context is bound in this transaction.
    //
    // Before 20260816000100 both halves of this test failed: `search.document` had no
    // row-level security at all, and `search.text_for` was SECURITY DEFINER with PostgreSQL's
    // default EXECUTE grant to PUBLIC, so an unbound session could read the assembled text —
    // including parsed controlled-document atoms — for any object id it could name.
    const visible = await withTransaction(h.pool, async (tx) =>
      tx.one<{ rows: string }>('select count(*)::text as rows from search.document'),
    );
    expect(visible.rows, 'an unbound session must see no indexed rows').toBe('0');

    for (const fn of ['search.text_for', 'search.text_for_structured_record']) {
      await expect(
        withTransaction(h.pool, async (tx) => tx.query(`select ${fn}($1)`, [board])),
        `${fn} must not be callable by the application role`,
      ).rejects.toThrow(/permission denied/i);
    }

    // rebuild() is an operator action. kf_app holding it through PUBLIC was the exact thing
    // the original migration's comment said it was preventing.
    await expect(
      withTransaction(h.pool, async (tx) => tx.query('select search.rebuild()')),
    ).rejects.toThrow(/permission denied/i);

    // The bound path is unaffected: same role, same pool, context set from the scope.
    const hits = await search(h.pool, restricted(), { text: 'leakage' });
    expect(hits.length).toBeGreaterThan(0);
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

/**
 * A search hit is a place a record appears, so it says whether anybody has verified it
 * (KF-SAS-RQ-229) — and says nothing about a record the caller cannot see.
 */
describe('verification on a hit', () => {
  beforeAll(async () => {
    const execute = createFabricDispatcher(
      h.pool,
      createDocumentActionAtoms({
        store: new InMemoryObjectStore(),
        parser: {
          async parse() {
            return undefined;
          },
        },
      }),
    );
    // Two different bases, so the second is not refused by the pace on individual review.
    for (const [target, basis] of [
      [percentLiteral, 'promoted_in_bulk'],
      [restrictedOrder, 'reviewed_individually'],
    ] as const) {
      const outcome = await execute({
        actionType: 'verify_record',
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        targetIds: [target],
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: `search-verify-${randomUUID()}`,
        reason: 'read it against the source',
        payload: { basis },
      });
      expect(outcome.status).toBe('applied');
    }
  }, 60_000);

  it('labels an unverified hit and names the basis of a verified one', async () => {
    const hits = await search(h.pool, restricted(), { text: 'ZX%Q' });
    expect(hits.find((x) => x.objectId === percentLiteral)?.verification).toMatchObject({
      verified: true,
      basis: 'promoted_in_bulk',
      verifiedBy: f.reviewerId,
    });
    const neighbours = await search(h.pool, restricted(), { text: 'Wildcard neighbour' });
    expect(neighbours.find((x) => x.objectId === percentWildcardNeighbour)?.verification).toEqual({
      verified: false,
      label: UNVERIFIED_LABEL,
    });
  });

  it('never reveals the verification of a record the caller cannot see', async () => {
    // Visible at restricted, and verified there.
    const seen = await search(h.pool, restricted(), { text: 'contractor day rate' });
    expect(seen.find((x) => x.objectId === restrictedOrder)?.verification.verified).toBe(true);
    // At internal the record is absent, and so is anything about its verification.
    const hidden = await search(h.pool, internal(), { text: 'contractor day rate' });
    expect(hidden.map((x) => x.objectId)).not.toContain(restrictedOrder);
    expect(JSON.stringify(hidden)).not.toContain('reviewed_individually');
    // The guard the hit relies on, probed directly: the verification row itself is invisible
    // to a session that cannot see the record (`object_verification_read` defers to the record).
    const rows = async (ceiling: string) =>
      withTransaction(h.pool, async (tx) => {
        await bindReader(tx, f, f.performerId, ceiling);
        return tx.query('select 1 from core.object_verification where object_id = $1', [
          restrictedOrder,
        ]);
      });
    expect(await rows('restricted')).toHaveLength(1);
    expect(await rows('internal')).toHaveLength(0);
  });
});
