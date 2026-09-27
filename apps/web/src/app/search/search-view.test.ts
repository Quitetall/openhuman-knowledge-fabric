import { describe, expect, it } from 'vitest';
import { parseSearchPageParams, recordHref, searchReturnPath } from './search-view.js';

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
      request: { text: '', limit: 50 },
    });
  });

  it('treats optional blank form controls as absent filters', () => {
    expect(
      parseSearchPageParams({ q: 'constitution', objectType: '', lifecycleState: '', limit: '50' }),
    ).toEqual({
      status: 'submitted',
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
      request: { text: 'x', limit: 50, nearMisses: true },
    });
    expect(parseSearchPageParams({ q: 'x' })).toEqual({
      status: 'submitted',
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
});
