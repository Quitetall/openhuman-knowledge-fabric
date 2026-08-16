import { get, type Caller } from './client';
import { hasStrings, record } from './validation';

export const SEARCH_RESULT_LIMIT = 200;

export interface SearchRequest {
  readonly text: string;
  readonly objectTypes?: readonly string[];
  readonly lifecycleStates?: readonly string[];
  readonly limit?: number;
}

export interface SearchHit {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  readonly rank: number;
  readonly matchedBy: 'full_text' | 'partial_identifier';
}

export interface SearchResponse {
  readonly hits: readonly SearchHit[];
}

function searchHit(value: unknown): value is SearchHit {
  const hit = record(value);
  return (
    hit !== undefined &&
    hasStrings(hit, ['objectId', 'objectType', 'title', 'lifecycleState', 'classification']) &&
    typeof hit['rank'] === 'number' &&
    Number.isFinite(hit['rank']) &&
    hit['rank'] >= 0 &&
    (hit['matchedBy'] === 'full_text' || hit['matchedBy'] === 'partial_identifier')
  );
}

export function parseSearchResponse(value: unknown): SearchResponse {
  const response = record(value);
  const hits = response?.['hits'];
  if (
    response === undefined ||
    !Array.isArray(hits) ||
    hits.length > SEARCH_RESULT_LIMIT ||
    !hits.every(searchHit)
  ) {
    throw new Error('search response did not match contract');
  }
  return response as unknown as SearchResponse;
}

export function buildSearchPath(request: SearchRequest): string {
  const params = new URLSearchParams({ q: request.text });
  for (const objectType of request.objectTypes ?? []) params.append('objectType', objectType);
  for (const state of request.lifecycleStates ?? []) params.append('lifecycleState', state);
  if (request.limit !== undefined) params.set('limit', String(request.limit));
  return `/search?${params.toString()}`;
}

export function getSearchResults(caller: Caller, request: SearchRequest): Promise<SearchResponse> {
  return get(buildSearchPath(request), caller, parseSearchResponse);
}
