import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '@kf/database';
import type { IdentifyCaller } from './actions.js';
import { registerSearchRoutes } from './search.js';

const ORGANIZATION_A = '11111111-1111-7111-8111-111111111111';
const ORGANIZATION_B = '22222222-2222-7222-8222-222222222222';

const INDEX_ROWS = [
  {
    object_id: '30000000-0000-7000-8000-000000000001',
    object_type: 'controlled_document',
    organization_id: ORGANIZATION_A,
    title: 'Document Constitution',
    lifecycle_state: 'draft',
    classification: 'internal',
    body: 'machine parsed document policy',
  },
  {
    object_id: '30000000-0000-7000-8000-000000000002',
    object_type: 'controlled_document',
    organization_id: ORGANIZATION_A,
    title: 'Restricted contingency plan',
    lifecycle_state: 'effective',
    classification: 'restricted',
    body: 'incident contingency',
  },
  {
    object_id: '30000000-0000-7000-8000-000000000003',
    object_type: 'controlled_document',
    organization_id: ORGANIZATION_B,
    title: 'Other organization document',
    lifecycle_state: 'draft',
    classification: 'internal',
    body: 'document policy',
  },
  {
    object_id: '30000000-0000-7000-8000-000000000004',
    object_type: 'decision_record',
    organization_id: ORGANIZATION_A,
    title: 'Compiler decision',
    lifecycle_state: 'accepted',
    classification: 'internal',
    body: 'compiler replacement',
  },
] as const;

const CLASSIFICATION_RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const TOO_MANY_OBJECT_TYPES = `/search?q=x&${Array.from(
  { length: 21 },
  (_, index) => `objectType=type_${index}`,
).join('&')}`;

function identify(overrides: Partial<Awaited<ReturnType<IdentifyCaller>>> = {}): IdentifyCaller {
  return vi.fn(async () => ({
    actorId: '40000000-0000-7000-8000-000000000001',
    actingRoleId: '40000000-0000-7000-8000-000000000002',
    organizationId: ORGANIZATION_A,
    maxClassification: 'internal',
    authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    ...overrides,
  }));
}

function searchPool() {
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    // Access is a grant on every read surface (ADR 0016). The fakes answer the two queries the
    // gate asks: the object's classification, and an organization-wide read grant.
    if (sql.includes('/* read-grant.classifications */')) {
      const ids = (params?.[0] ?? []) as readonly string[];
      return { rows: ids.map((id) => ({ id, classification: 'internal' })) };
    }
    if (sql.includes('/* access-grants.coverage */')) {
      return {
        rows: [
          {
            source: 'role_assignment',
            source_id: 'fake-assignment',
            scope_object_id: ORGANIZATION_A,
            classification_ceiling: null,
            reason: 'role performer',
          },
        ],
      };
    }
    // The caller is bound as a principal (core.bind_principal, 20260923000100); the database
    // answers with the ceiling it bound, which the fake takes as the one requested.
    if (sql.includes('core.bind_principal')) return { rows: [{ ceiling: params[3] }] };
    // A query is recorded as a transient observation (§64B); the seam answers with its id.
    if (sql.includes('search.record_query')) return { rows: [{ id: 'recorded-query' }] };
    const matching = (params: readonly unknown[]) => {
      const [organizationId, maxClassification, text, objectTypes, lifecycleStates, only] =
        params as [string, string, string, string[] | null, string[] | null, string[] | null];
      const rank = CLASSIFICATION_RANK[maxClassification] ?? -1;
      const needle = text.toLowerCase();
      return INDEX_ROWS.filter(
        (row) =>
          row.organization_id === organizationId &&
          CLASSIFICATION_RANK[row.classification]! <= rank &&
          (objectTypes === null || objectTypes.includes(row.object_type)) &&
          (lifecycleStates === null || lifecycleStates.includes(row.lifecycle_state)) &&
          `${row.title} ${row.body}`.toLowerCase().includes(needle) &&
          (only === null || only.includes(row.object_id)),
      );
    };
    if (sql.includes('/* search.lexical-matches */')) {
      return {
        rows: matching(params).map((row) => ({
          object_id: row.object_id,
          classification: row.classification,
          coverage: 1,
          matched_by: 'full_text',
        })),
      };
    }
    if (!sql.includes('/* search.lexical-page */')) return { rows: [] };
    const ids = params[0] as readonly string[];
    const rows = INDEX_ROWS.filter((row) => ids.includes(row.object_id))
      // The columns the real query adds from `core.object` and `core.object_verification`:
      // every fake record is visible and nobody has verified any of them.
      .map((row) => ({
        ...row,
        phrase: false,
        text_rank: 0.1,
        record_visible: true,
        verified_at: null,
        verified_by: null,
        verification_basis: null,
      }));
    return { rows };
  });
  const connect = vi.fn(async () => ({ query, release: vi.fn() }));
  return { pool: { connect } as unknown as Pool, query, connect };
}

async function appFor(options: { readonly identify?: IdentifyCaller } = {}) {
  const database = searchPool();
  const app = Fastify({ logger: false });
  await registerSearchRoutes(app, {
    pool: database.pool,
    identify: options.identify ?? identify(),
  });
  return { app, ...database };
}

describe('GET /search', () => {
  it('passes organization and classification scope to canonical search without leaking hidden hits', async () => {
    const low = await appFor();
    const lowResponse = await low.app.inject({ method: 'GET', url: '/search?q=contingency' });
    expect(lowResponse.statusCode).toBe(200);
    expect(lowResponse.json()).toMatchObject({ hits: [], withheldCount: 0 });
    expect(low.query).toHaveBeenCalledWith(
      expect.stringContaining('/* search.lexical-matches */'),
      [ORGANIZATION_A, 'internal', 'contingency', null, null, null],
    );

    const high = await appFor({ identify: identify({ maxClassification: 'restricted' }) });
    const highResponse = await high.app.inject({ method: 'GET', url: '/search?q=contingency' });
    expect(highResponse.json()).toMatchObject({
      hits: [{ objectId: INDEX_ROWS[1].object_id, classification: 'restricted' }],
    });
  });

  it('keeps another organization absent, not redacted or counted', async () => {
    const { app } = await appFor();
    const response = await app.inject({ method: 'GET', url: '/search?q=Other+organization' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ hits: [], withheldCount: 0 });
    expect(response.body).not.toContain(ORGANIZATION_B);
  });

  it('applies exact object type and lifecycle filters with a bounded limit', async () => {
    const { app, query } = await appFor();
    const response = await app.inject({
      method: 'GET',
      url: '/search?q=compiler&objectType=decision_record&lifecycleState=accepted&limit=25',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hits: [{ objectType: 'decision_record', lifecycleState: 'accepted' }],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('/* search.lexical-matches */'), [
      ORGANIZATION_A,
      'internal',
      'compiler',
      ['decision_record'],
      ['accepted'],
      null,
    ]);
    // The page is cut from the matches the caller's grants reach, and only they are read.
    expect(query).toHaveBeenCalledWith(expect.stringContaining('/* search.lexical-page */'), [
      [INDEX_ROWS[3].object_id],
      'compiler',
    ]);
  });

  it('treats blank optional form filters as absent', async () => {
    const { app, query } = await appFor();
    const response = await app.inject({
      method: 'GET',
      url: '/search?q=document&objectType=&lifecycleState=&limit=50',
    });
    expect(response.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('/* search.lexical-matches */'), [
      ORGANIZATION_A,
      'internal',
      'document',
      null,
      null,
      null,
    ]);
  });

  it('returns no hits for an empty query without running ranked search', async () => {
    const { app, query } = await appFor();
    const response = await app.inject({ method: 'GET', url: '/search?q=+++%20' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ hits: [], withheld: [] });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('/* search.lexical-matches */')),
    ).toBe(false);
  });

  it('serves lexical results and says why there is no semantic ranking when no engine is configured', async () => {
    const { app } = await appFor();
    const response = await app.inject({ method: 'GET', url: '/search?q=document' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.lexical).toMatchObject({
      ranking: 'kf.lexical.idf_coverage(floor=0.5)+phrase+partial_identifier.v2',
      exhaustive: true,
    });
    // One list to read first; without an engine it is the lexical page, and says so.
    expect(body.ranked.ranking).toBe(
      'kf.fused.rrf.v2(k=60; lexical vote=(coverage-0.5)/0.5; kf.lexical.idf_coverage(floor=0.5)+phrase+partial_identifier.v2)',
    );
    expect(body.ranked.hits.map((hit: { objectId: string }) => hit.objectId)).toEqual(
      body.lexical.hits.map((hit: { objectId: string }) => hit.objectId),
    );
    expect(body.lexical.hits.length).toBeGreaterThan(0);
    expect(body.hits).toEqual(body.lexical.hits);
    expect(body.semantic).toBeUndefined();
    expect(body.nearMisses).toBeUndefined();
    expect(body.withheld).toEqual([
      { reasonClass: 'semantic_ranking_unavailable', reason: 'no retrieval engine is configured' },
    ]);
  });

  it.each([
    ['/search?q=x&nearMisses=yes', 'nearMisses'],
    ['/search?q=first&q=second', 'q'],
    ['/search?q=x&limit=0', 'limit'],
    ['/search?q=x&limit=201', 'limit'],
    ['/search?q=x&limit=1.5', 'limit'],
    ['/search?q=x&objectType=not%20valid', 'objectType'],
    ['/search?q=x&lifecycleState=!', 'lifecycleState'],
    [`/search?q=${'x'.repeat(513)}`, 'q'],
    [`/search?q=x&objectType=${'x'.repeat(65)}`, 'objectType'],
    [TOO_MANY_OBJECT_TYPES, 'objectType'],
  ])('refuses malformed or oversized input: %s', async (url, field) => {
    const { app, query } = await appFor();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_search_query', field });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('/* search.lexical-matches */')),
    ).toBe(false);
  });

  it('refuses access before opening a database transaction', async () => {
    const rejected = vi.fn(async () => {
      throw new Error('identity rejected');
    });
    const { app, connect } = await appFor({ identify: rejected });
    const response = await app.inject({ method: 'GET', url: '/search?q=document' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'caller_unidentified' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('does not expose database details in a failed search response', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('/* search.lexical-matches */'))
        throw new Error('hidden title: acquisition target');
      return { rows: [] };
    });
    const app = Fastify({ logger: false });
    await registerSearchRoutes(app, {
      pool: {
        connect: vi.fn(async () => ({ query, release: vi.fn() })),
      } as unknown as Pool,
      identify: identify(),
    });

    const response = await app.inject({ method: 'GET', url: '/search?q=target' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'search_unavailable' });
    expect(response.body).not.toContain('acquisition target');
  });
});
