import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from './client.js';
import {
  buildSearchPath,
  getOwnRecordedQueries,
  getSearchResults,
  parseOwnRecordedQueries,
  parseRecordedQueryReplay,
  parseSearchResponse,
  replayRecordedQuery,
} from './search.js';
import { UNVERIFIED_LABEL } from './verification.js';

const caller: Caller = {
  authentication: 'development',
  actorId: 'actor-1',
  actingRoleId: 'role-1',
  organizationId: 'organization-1',
  maxClassification: 'internal',
};

const originalApiUrl = process.env['KF_API_URL'];

/** The composed answer around a lexical list, as GET /search sends it. */
function composed<T>(hits: readonly T[], extra: Record<string, unknown> = {}) {
  return {
    hits,
    lexical: {
      ranking: 'kf.lexical.full_text+partial_identifier.v1',
      exhaustive: true,
      total: hits.length,
      complete: true,
      hits,
    },
    withheld: [],
    withheldCount: 0,
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalApiUrl === undefined) delete process.env['KF_API_URL'];
  else process.env['KF_API_URL'] = originalApiUrl;
});

describe('search API client', () => {
  it('decodes only complete, explainable search hits', () => {
    const body = composed([
      {
        objectId: 'document-1',
        objectType: 'controlled_document',
        title: 'Document Constitution',
        lifecycleState: 'draft',
        classification: 'internal',
        rank: 0.75,
        matchedBy: 'full_text',
        verification: { verified: false, label: UNVERIFIED_LABEL },
      },
    ]);
    const parsed = parseSearchResponse(body);
    expect(parsed.hits).toEqual(body.hits);
    expect(parsed.lexical.hits).toEqual(body.hits);
    // KF-SAS-RQ-229, failing closed: a hit that does not say is shown as unverified, and one
    // claiming verification without the facts that make it so is not believed.
    const { verification: _omitted, ...bare } = body.hits[0]!;
    expect(parseSearchResponse(composed([bare])).hits[0]!.verification).toEqual({
      verified: false,
      label: UNVERIFIED_LABEL,
    });
    expect(
      parseSearchResponse(
        composed([{ ...bare, verification: { verified: true, label: 'verified, honest' } }]),
      ).hits[0]!.verification.verified,
    ).toBe(false);
    expect(() =>
      parseSearchResponse(composed([{ ...body.hits[0], matchedBy: 'embedding' }])),
    ).toThrow(/search response/);
    expect(() => parseSearchResponse(composed([{ ...body.hits[0], rank: -1 }]))).toThrow(
      /search response/,
    );
  });

  it('rejects an oversized result set even if every row is individually valid', () => {
    const hit = {
      objectId: 'document-1',
      objectType: 'controlled_document',
      title: 'Document Constitution',
      lifecycleState: 'draft',
      classification: 'internal',
      rank: 0.5,
      matchedBy: 'partial_identifier',
    };
    expect(() => parseSearchResponse(composed(Array.from({ length: 201 }, () => hit)))).toThrow(
      /search response/,
    );
  });

  it('encodes text and repeated exact filters without changing their values', () => {
    expect(
      buildSearchPath({
        text: 'CNB-22 & leakage',
        objectTypes: ['configuration_item', 'controlled_document'],
        lifecycleStates: ['effective'],
        limit: 25,
      }),
    ).toBe(
      '/search?q=CNB-22+%26+leakage&objectType=configuration_item&objectType=controlled_document&lifecycleState=effective&limit=25',
    );
  });

  it('forwards caller context through the shared authenticated GET boundary', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(composed([])), { status: 200 }));

    await getSearchResults(caller, { text: 'constitution', limit: 50 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/search?q=constitution&limit=50',
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({
          'x-kf-actor': caller.actorId,
          'x-kf-organization': caller.organizationId,
          'x-kf-classification': caller.maxClassification,
        }),
      }),
    );
  });
});

describe('the composed answer (KF-SAS-RQ-224, RQ-217, ADR 0037)', () => {
  const semanticHit = {
    objectId: 'document-2',
    objectType: 'controlled_document',
    title: 'Retention schedule',
    lifecycleState: 'effective',
    classification: 'internal',
    rank: 1,
    score: 0.82,
  };

  it('keeps each list and the name of the ranking that produced it', () => {
    const parsed = parseSearchResponse(
      composed([], {
        semantic: { ranking: 'lamu.embed.bge-m3.v1', hits: [semanticHit] },
        nearMisses: {
          label: 'near_miss',
          scoringFunction: 'kf.near-miss.rank-window.v1(lamu.embed.bge-m3.v1; ranks 51-100)',
          hits: [{ ...semanticHit, objectId: 'document-3', rank: 51 }],
        },
        withheldCount: 3,
      }),
    );
    expect(parsed.lexical.ranking).toBe('kf.lexical.full_text+partial_identifier.v1');
    expect(parsed.semantic?.ranking).toBe('lamu.embed.bge-m3.v1');
    expect(parsed.semantic?.hits[0]!.verification.verified).toBe(false);
    expect(parsed.nearMisses?.label).toBe('near_miss');
    expect(parsed.withheldCount).toBe(3);
  });

  it('carries the reason the engine could not rank', () => {
    const parsed = parseSearchResponse(
      composed([], {
        withheld: [
          {
            reasonClass: 'semantic_ranking_unavailable',
            reason: 'no retrieval engine is configured',
          },
        ],
      }),
    );
    expect(parsed.semantic).toBeUndefined();
    expect(parsed.withheld).toEqual([
      { reasonClass: 'semantic_ranking_unavailable', reason: 'no retrieval engine is configured' },
    ]);
  });

  it('refuses a response without the composed fields rather than guessing them', () => {
    expect(() => parseSearchResponse({ hits: [] })).toThrow(/search response/);
    expect(() => parseSearchResponse({ ...composed([]), withheldCount: -1 })).toThrow(
      /search response/,
    );
    expect(() =>
      parseSearchResponse(composed([], { semantic: { ranking: '', hits: [] } })),
    ).toThrow(/search response/);
  });

  it('asks for near misses only when requested', () => {
    expect(buildSearchPath({ text: 'x' })).toBe('/search?q=x');
    expect(buildSearchPath({ text: 'x', nearMisses: true })).toBe('/search?q=x&nearMisses=true');
  });
});

describe('the caller’s own recorded queries (KF-SAS-RQ-221)', () => {
  const ID = '0199a000-0000-7000-8000-000000000001';
  const listing = {
    queries: [
      {
        id: ID,
        text: 'tantalum capacitor',
        askerCeiling: 'internal',
        recordedAt: '2026-09-24T10:00:00.000Z',
        expiresAt: '2026-12-23T10:00:00.000Z',
      },
    ],
  };

  it('decodes the listing and refuses one that is off contract', () => {
    expect(parseOwnRecordedQueries(listing)).toEqual(listing.queries);
    expect(() =>
      parseOwnRecordedQueries({ queries: [{ ...listing.queries[0], id: 'not-a-uuid' }] }),
    ).toThrow(/recorded query listing/);
    expect(() => parseOwnRecordedQueries({})).toThrow(/recorded query listing/);
  });

  it('decodes a replay: what was withheld, and how much it counted', () => {
    const replay = parseRecordedQueryReplay({
      recordedQueryId: ID,
      askerCeiling: 'internal',
      withheld: [
        {
          objectId: 'document-9',
          objectType: 'decision_record',
          title: 'Second source pricing',
          lifecycleState: 'draft',
          classification: 'restricted',
          rank: 0.4,
          matchedBy: 'full_text',
        },
      ],
      counted: 1,
    });
    expect(replay.counted).toBe(1);
    expect(replay.withheld[0]!.verification.verified).toBe(false);
    expect(() =>
      parseRecordedQueryReplay({ recordedQueryId: ID, askerCeiling: 'internal' }),
    ).toThrow(/recorded query replay/);
  });

  it('lists by GET and replays by POST through the caller’s context, naming no person', async () => {
    process.env['KF_API_URL'] = 'https://api.example.test';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(listing), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            recordedQueryId: ID,
            askerCeiling: 'internal',
            withheld: [],
            counted: 0,
          }),
          { status: 200 },
        ),
      );
    await getOwnRecordedQueries(caller);
    await replayRecordedQuery(caller, ID);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.test/search/recorded-queries');
    expect(fetchMock.mock.calls[1]![0]).toBe(
      `https://api.example.test/search/recorded-queries/${ID}/replay`,
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    await expect(replayRecordedQuery(caller, '../admin')).rejects.toThrow(/UUID/);
  });
});
