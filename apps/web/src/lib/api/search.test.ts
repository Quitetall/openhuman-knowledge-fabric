import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from './client.js';
import { buildSearchPath, getSearchResults, parseSearchResponse } from './search.js';

const caller: Caller = {
  authentication: 'development',
  actorId: 'actor-1',
  actingRoleId: 'role-1',
  organizationId: 'organization-1',
  maxClassification: 'internal',
};

const originalApiUrl = process.env['KF_API_URL'];

afterEach(() => {
  vi.restoreAllMocks();
  if (originalApiUrl === undefined) delete process.env['KF_API_URL'];
  else process.env['KF_API_URL'] = originalApiUrl;
});

describe('search API client', () => {
  it('decodes only complete, explainable search hits', () => {
    const body = {
      hits: [
        {
          objectId: 'document-1',
          objectType: 'controlled_document',
          title: 'Document Constitution',
          lifecycleState: 'draft',
          classification: 'internal',
          rank: 0.75,
          matchedBy: 'full_text',
        },
      ],
    };
    expect(parseSearchResponse(body)).toEqual(body);
    expect(() =>
      parseSearchResponse({
        hits: [{ ...body.hits[0], matchedBy: 'embedding' }],
      }),
    ).toThrow(/search response/);
    expect(() =>
      parseSearchResponse({
        hits: [{ ...body.hits[0], rank: -1 }],
      }),
    ).toThrow(/search response/);
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
    expect(() => parseSearchResponse({ hits: Array.from({ length: 201 }, () => hit) })).toThrow(
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
      .mockResolvedValue(new Response(JSON.stringify({ hits: [] }), { status: 200 }));

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
