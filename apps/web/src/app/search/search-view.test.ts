import { describe, expect, it } from 'vitest';
import type { SearchResponse } from '../../lib/api';
import { UNVERIFIED_LABEL } from '../../lib/api/verification.js';
import {
  meaningUnavailable,
  parseSearchPageParams,
  recordHref,
  searchByMeaning,
  searchPageHref,
  searchReturnPath,
  shownList,
} from './search-view.js';

describe('search page query', () => {
  it('preserves exact repeated filters for the API request', () => {
    expect(
      parseSearchPageParams({
        q: 'leakage current',
        objectType: ['nonconformity', 'controlled_document'],
        lifecycleState: 'effective',
        limit: '25',
      }),
    ).toEqual({
      status: 'submitted',
      meaning: true,
      request: {
        text: 'leakage current',
        objectTypes: ['nonconformity', 'controlled_document'],
        lifecycleStates: ['effective'],
        limit: 25,
      },
    });
  });

  it('distinguishes an unopened search page from an intentionally empty query', () => {
    expect(parseSearchPageParams({})).toEqual({ status: 'idle' });
    expect(parseSearchPageParams({ q: '' })).toEqual({
      status: 'submitted',
      meaning: true,
      request: { text: '', limit: 50 },
    });
  });

  it('treats optional blank form controls as absent filters', () => {
    expect(
      parseSearchPageParams({ q: 'constitution', objectType: '', lifecycleState: '', limit: '50' }),
    ).toEqual({
      status: 'submitted',
      meaning: true,
      request: { text: 'constitution', limit: 50 },
    });
  });

  it.each([
    { q: ['first', 'second'] },
    { q: 'x', limit: '0' },
    { q: 'x', limit: '201' },
    { q: 'x', objectType: 'not valid' },
    { q: 'x', lifecycleState: Array.from({ length: 21 }, () => 'draft') },
    { q: 'x'.repeat(513) },
  ])('fails closed on malformed URL state: $q', (params) => {
    expect(parseSearchPageParams(params)).toEqual({ status: 'invalid' });
  });
});

describe('search result navigation', () => {
  it('links every hit: dossier routes where they exist, the Object View otherwise', () => {
    expect(recordHref('controlled_document', 'document-1')).toBe('/documents/document-1');
    expect(recordHref('initiative_project', 'project-1')).toBe('/projects/project-1');
    expect(recordHref('decision_record', 'decision-1')).toBe('/objects/decision-1');
    expect(recordHref('artifact', 'a/b?c')).toBe('/objects/a%2Fb%3Fc');
  });

  it('asks for near misses only when the box is ticked, and refuses any other value', () => {
    expect(parseSearchPageParams({ q: 'x', nearMisses: 'true' })).toEqual({
      status: 'submitted',
      meaning: true,
      request: { text: 'x', limit: 50, nearMisses: true },
    });
    expect(parseSearchPageParams({ q: 'x' })).toEqual({
      status: 'submitted',
      meaning: true,
      request: { text: 'x', limit: 50 },
    });
    expect(parseSearchPageParams({ q: 'x', nearMisses: 'yes' })).toEqual({ status: 'invalid' });
  });
});

describe('search return path', () => {
  it("keeps the query across sign-in, and only the page's own parameters", () => {
    expect(searchReturnPath({})).toBe('/search');
    expect(
      searchReturnPath({
        q: 'qualité & co',
        objectType: ['artifact', 'nonconformity'],
        limit: '25',
        next: '//evil.test',
      }),
    ).toBe('/search?q=qualit%C3%A9+%26+co&objectType=artifact&objectType=nonconformity&limit=25');
  });

  it('keeps the "Search by meaning" switch across sign-in, in whichever shape it came', () => {
    expect(searchReturnPath({ q: 'torque', meaning: 'off' })).toBe('/search?q=torque&meaning=off');
    expect(searchReturnPath({ q: 'torque', meaning: ['off', 'on'] })).toBe(
      '/search?q=torque&meaning=off&meaning=on',
    );
  });
});

describe('the "Search by meaning" switch in the address', () => {
  it('is on by default, off only when the address says off, and on again when ticked', () => {
    // No parameter: a shared link, a bookmark. Script on: only `off` is ever sent.
    expect(searchByMeaning(undefined)).toBe(true);
    expect(searchByMeaning('off')).toBe(false);
    expect(searchByMeaning('on')).toBe(true);
    // No script: the hidden `off` and then the ticked checkbox's `on`; the last one counts.
    expect(searchByMeaning(['off', 'on'])).toBe(true);
  });

  it.each([
    ['OFF'],
    ['false'],
    ['0'],
    [''],
    [['on', 'off']],
    [['off', 'off']],
    [['off', 'on', 'on']],
    [[]],
  ])('refuses %j rather than guessing', (value) => {
    expect(searchByMeaning(value as string | readonly string[])).toBeUndefined();
    expect(parseSearchPageParams({ q: 'x', meaning: value as string | string[] })).toEqual({
      status: 'invalid',
    });
  });

  it('reaches the parsed page and leaves the API request untouched', () => {
    expect(parseSearchPageParams({ q: 'x', meaning: 'off' })).toEqual({
      status: 'submitted',
      meaning: false,
      request: { text: 'x', limit: 50 },
    });
    expect(parseSearchPageParams({ q: 'x', meaning: ['off', 'on'] })).toEqual({
      status: 'submitted',
      meaning: true,
      request: { text: 'x', limit: 50 },
    });
  });

  it('carries the switch from Home to the full search page only when it is off', () => {
    expect(searchPageHref('torque drift', true)).toBe('/search?q=torque+drift');
    expect(searchPageHref('torque drift', false)).toBe('/search?q=torque+drift&meaning=off');
  });
});

const unverified = { verified: false, label: UNVERIFIED_LABEL } as const;
const wordHit = {
  objectId: 'word-1',
  objectType: 'decision_record',
  title: 'Word record',
  lifecycleState: 'accepted',
  classification: 'internal',
  rank: 0.9,
  matchedBy: 'full_text' as const,
  verification: unverified,
};
const meaningHit = {
  ...wordHit,
  objectId: 'meaning-1',
  title: 'Meaning record',
  rank: 1,
  score: 0.8,
};

function answer(extra: Partial<SearchResponse> = {}): SearchResponse {
  return {
    ranked: {
      ranking: 'kf.fused.rrf.v1',
      hits: [
        { ...wordHit, rank: 1, score: 0.03, lexical: { rank: 1, matchedBy: 'full_text' } },
        { ...meaningHit, rank: 2, score: 0.016, semantic: { rank: 1 } },
      ],
    },
    lexical: { ranking: 'kf.lexical', total: 7, complete: false, hits: [wordHit] },
    semantic: { ranking: 'lamu.embed', hits: [meaningHit] },
    withheld: [],
    withheldCount: 3,
    hits: [wordHit],
    ...extra,
  };
}

describe('which list the switch shows', () => {
  it('on: the fused list, meaning and words together', () => {
    const list = shownList(answer(), true);
    expect(list.kind).toBe('ranked');
    expect(list.hits.map((hit) => hit.objectId)).toEqual(['word-1', 'meaning-1']);
    expect(list).toMatchObject({ meaningUnavailable: false });
  });

  it('off: only the word matches, with their total, and no record found by meaning', () => {
    const list = shownList(answer(), false);
    expect(list).toEqual({
      kind: 'lexical',
      ranking: 'kf.lexical',
      hits: [wordHit],
      total: 7,
      complete: false,
    });
  });

  it('on, when the engine did not answer: says so rather than passing words off as meaning', () => {
    const { semantic: _semantic, ...withoutEngine } = answer();
    const unavailable = {
      ...withoutEngine,
      withheld: [{ reasonClass: 'semantic_ranking_unavailable', reason: 'engine down' }],
    };
    expect(meaningUnavailable(unavailable)).toBe(true);
    expect(shownList(unavailable, true)).toMatchObject({
      kind: 'ranked',
      meaningUnavailable: true,
    });
    // No semantic list and no reason given is still not a meaning search.
    expect(meaningUnavailable(withoutEngine)).toBe(true);
    expect(meaningUnavailable(answer())).toBe(false);
  });
});
