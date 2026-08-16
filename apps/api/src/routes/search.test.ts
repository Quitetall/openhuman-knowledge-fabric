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
    if (!sql.includes('with visible as')) return { rows: [] };
    const [organizationId, maxClassification, text, objectTypes, lifecycleStates, limit] =
      params as [string, string, string, string[] | null, string[] | null, number];
    const rank = CLASSIFICATION_RANK[maxClassification] ?? -1;
    const needle = text.toLowerCase();
    const rows = INDEX_ROWS.filter(
      (row) =>
        row.organization_id === organizationId &&
        CLASSIFICATION_RANK[row.classification]! <= rank &&
        (objectTypes === null || objectTypes.includes(row.object_type)) &&
        (lifecycleStates === null || lifecycleStates.includes(row.lifecycle_state)) &&
        `${row.title} ${row.body}`.toLowerCase().includes(needle),
    )
      .slice(0, limit)
      .map((row) => ({ ...row, rank: 0.75, matched_by: 'full_text' }));
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
    expect(lowResponse.json()).toEqual({ hits: [] });
    expect(low.query).toHaveBeenCalledWith(expect.stringContaining('with visible as'), [
      ORGANIZATION_A,
      'internal',
      'contingency',
      null,
      null,
      50,
    ]);

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
    expect(response.json()).toEqual({ hits: [] });
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
    expect(query).toHaveBeenCalledWith(expect.stringContaining('with visible as'), [
      ORGANIZATION_A,
      'internal',
      'compiler',
      ['decision_record'],
      ['accepted'],
      25,
    ]);
  });

  it('treats blank optional form filters as absent', async () => {
    const { app, query } = await appFor();
    const response = await app.inject({
      method: 'GET',
      url: '/search?q=document&objectType=&lifecycleState=&limit=50',
    });
    expect(response.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('with visible as'), [
      ORGANIZATION_A,
      'internal',
      'document',
      null,
      null,
      50,
    ]);
  });

  it('returns no hits for an empty query without running ranked search', async () => {
    const { app, query } = await appFor();
    const response = await app.inject({ method: 'GET', url: '/search?q=+++%20' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hits: [] });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('with visible as'))).toBe(false);
  });

  it.each([
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
    expect(query.mock.calls.some(([sql]) => String(sql).includes('with visible as'))).toBe(false);
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
      if (sql.includes('with visible as')) throw new Error('hidden title: acquisition target');
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
