import { apiBaseUrl, callerHeaders, decodeSuccessfulResponse, get, parseResponse } from './client';
import type { Caller } from './client';
import { hasStrings, nonNegativeInteger, record } from './validation';
import { parseVerification, type Verification } from './verification';

export const SEARCH_RESULT_LIMIT = 200;

export interface SearchRequest {
  readonly text: string;
  readonly objectTypes?: readonly string[];
  readonly lifecycleStates?: readonly string[];
  readonly limit?: number;
  /** Near misses are returned only when asked for (KF-SAS-RQ-217). */
  readonly nearMisses?: boolean;
}

export interface SearchHit {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  readonly rank: number;
  readonly matchedBy: 'full_text' | 'partial_identifier';
  /** Always present: a hit the API sent without one is shown as unverified. */
  readonly verification: Verification;
}

/** A hit from the retrieval engine's ranking, re-checked by the API under the caller's access. */
export interface SemanticSearchHit {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  readonly rank: number;
  readonly score: number;
  readonly verification: Verification;
}

/** Why a part of the answer could not be given (§63): the semantic ranking, today. */
export interface WithholdingNote {
  readonly reasonClass: string;
  readonly reason: string;
}

/**
 * One query, two rankings, composed rather than merged (KF-SAS-RQ-224). Each list keeps the name
 * of the ranking that produced it, and the page shows them apart: the lexical list is the complete
 * answer within its scope, the semantic one cannot be.
 */
export interface SearchResponse {
  readonly lexical: {
    readonly ranking: string;
    readonly total: number;
    readonly complete: boolean;
    readonly hits: readonly SearchHit[];
  };
  readonly semantic?: { readonly ranking: string; readonly hits: readonly SemanticSearchHit[] };
  readonly nearMisses?: {
    readonly label: string;
    readonly scoringFunction: string;
    readonly hits: readonly SemanticSearchHit[];
  };
  readonly withheld: readonly WithholdingNote[];
  /** Matching records within the caller's ceiling that no grant reaches (ADR 0037). */
  readonly withheldCount: number;
  /** The lexical hits again, as the API repeats them for clients written before composition. */
  readonly hits: readonly SearchHit[];
}

function searchHit(value: unknown): value is Omit<SearchHit, 'verification'> {
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

function semanticHit(value: unknown): value is Omit<SemanticSearchHit, 'verification'> {
  const hit = record(value);
  return (
    hit !== undefined &&
    hasStrings(hit, ['objectId', 'objectType', 'title', 'lifecycleState', 'classification']) &&
    typeof hit['rank'] === 'number' &&
    Number.isFinite(hit['rank']) &&
    hit['rank'] >= 0 &&
    typeof hit['score'] === 'number' &&
    Number.isFinite(hit['score'])
  );
}

function withVerification<T extends object>(hit: T): T & { readonly verification: Verification } {
  return {
    ...hit,
    verification: parseVerification((hit as Record<string, unknown>)['verification']),
  };
}

function hitList<T>(value: unknown, valid: (item: unknown) => item is T): T[] {
  if (!Array.isArray(value) || value.length > SEARCH_RESULT_LIMIT || !value.every(valid)) {
    throw new Error('search response did not match contract');
  }
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 512;
}

function contractBroken(): never {
  throw new Error('search response did not match contract');
}

/** Decode the composed answer. Anything off contract fails the whole response, never one list. */
export function parseSearchResponse(value: unknown): SearchResponse {
  const response = record(value);
  const lexical = record(response?.['lexical']);
  if (
    response === undefined ||
    lexical === undefined ||
    !nonEmptyString(lexical['ranking']) ||
    !nonNegativeInteger(lexical['total']) ||
    typeof lexical['complete'] !== 'boolean' ||
    !nonNegativeInteger(response['withheldCount']) ||
    !Array.isArray(response['withheld'])
  ) {
    contractBroken();
  }
  const lexicalHits = hitList(lexical['hits'], searchHit).map(withVerification);
  const withheld = (response['withheld'] as unknown[]).map((entry) => {
    const note = record(entry);
    if (
      note === undefined ||
      !nonEmptyString(note['reasonClass']) ||
      !nonEmptyString(note['reason'])
    ) {
      return contractBroken();
    }
    return { reasonClass: note['reasonClass'], reason: note['reason'] };
  });

  let semantic: SearchResponse['semantic'];
  if (response['semantic'] !== undefined) {
    const list = record(response['semantic']);
    if (list === undefined || !nonEmptyString(list['ranking'])) contractBroken();
    semantic = {
      ranking: list['ranking'],
      hits: hitList(list['hits'], semanticHit).map(withVerification),
    };
  }

  let nearMisses: SearchResponse['nearMisses'];
  if (response['nearMisses'] !== undefined) {
    const list = record(response['nearMisses']);
    if (
      list === undefined ||
      !nonEmptyString(list['label']) ||
      !nonEmptyString(list['scoringFunction'])
    ) {
      contractBroken();
    }
    nearMisses = {
      label: list['label'],
      scoringFunction: list['scoringFunction'],
      hits: hitList(list['hits'], semanticHit).map(withVerification),
    };
  }

  return {
    lexical: {
      ranking: lexical['ranking'],
      total: lexical['total'],
      complete: lexical['complete'],
      hits: lexicalHits,
    },
    ...(semantic === undefined ? {} : { semantic }),
    ...(nearMisses === undefined ? {} : { nearMisses }),
    withheld,
    withheldCount: response['withheldCount'],
    hits: lexicalHits,
  };
}

export function buildSearchPath(request: SearchRequest): string {
  const params = new URLSearchParams({ q: request.text });
  for (const objectType of request.objectTypes ?? []) params.append('objectType', objectType);
  for (const state of request.lifecycleStates ?? []) params.append('lifecycleState', state);
  if (request.limit !== undefined) params.set('limit', String(request.limit));
  if (request.nearMisses === true) params.set('nearMisses', 'true');
  return `/search?${params.toString()}`;
}

export function getSearchResults(caller: Caller, request: SearchRequest): Promise<SearchResponse> {
  return get(buildSearchPath(request), caller, parseSearchResponse);
}

// ── The caller's own recorded queries (KF-SAS-RQ-221) ─────────────────────────────────────────

export interface OwnRecordedQuery {
  readonly id: string;
  readonly text: string;
  readonly askerCeiling: string;
  readonly recordedAt: string;
  readonly expiresAt: string;
}

export interface RecordedQueryReplay {
  readonly recordedQueryId: string;
  readonly askerCeiling: string;
  /** What the ceiling the query ran at withheld, that the caller may read now. Not stored. */
  readonly withheld: readonly SearchHit[];
  /** How many of them counted as this person's demand for the first time. */
  readonly counted: number;
}

export const RECORDED_QUERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function parseOwnRecordedQueries(value: unknown): readonly OwnRecordedQuery[] {
  const queries = record(value)?.['queries'];
  if (!Array.isArray(queries) || queries.length > SEARCH_RESULT_LIMIT) {
    throw new Error('recorded query listing did not match contract');
  }
  return queries.map((entry: unknown) => {
    const q = record(entry);
    if (
      q === undefined ||
      !hasStrings(q, ['id', 'text', 'askerCeiling', 'recordedAt', 'expiresAt']) ||
      !RECORDED_QUERY_ID.test(q['id'] as string)
    ) {
      throw new Error('recorded query listing did not match contract');
    }
    return {
      id: q['id'] as string,
      text: q['text'] as string,
      askerCeiling: q['askerCeiling'] as string,
      recordedAt: q['recordedAt'] as string,
      expiresAt: q['expiresAt'] as string,
    };
  });
}

export function parseRecordedQueryReplay(value: unknown): RecordedQueryReplay {
  const body = record(value);
  if (
    body === undefined ||
    !hasStrings(body, ['recordedQueryId', 'askerCeiling']) ||
    !nonNegativeInteger(body['counted'])
  ) {
    throw new Error('recorded query replay did not match contract');
  }
  return {
    recordedQueryId: body['recordedQueryId'] as string,
    askerCeiling: body['askerCeiling'] as string,
    withheld: hitList(body['withheld'], searchHit).map(withVerification),
    counted: body['counted'],
  };
}

export function getOwnRecordedQueries(caller: Caller): Promise<readonly OwnRecordedQuery[]> {
  return get('/search/recorded-queries', caller, parseOwnRecordedQueries);
}

export async function replayRecordedQuery(
  caller: Caller,
  id: string,
): Promise<RecordedQueryReplay> {
  if (!RECORDED_QUERY_ID.test(id)) throw new Error('recorded query id must be a UUID');
  const response = await fetch(`${apiBaseUrl()}/search/recorded-queries/${id}/replay`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: '{}',
    cache: 'no-store',
  });
  return decodeSuccessfulResponse(await parseResponse(response), parseRecordedQueryReplay);
}

/** A record lower-clearance queries wanted, as the demand aggregate counts it: never who. */
export interface DemandedRecord {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly classification: string;
  readonly distinctPersonCount: number;
  readonly verification: Verification;
}

/** What one demand replay found. It carries no query, no query id or time, and no asker. */
export interface DemandReplay {
  readonly replayed: number;
  readonly truncated: boolean;
  readonly counted: number;
  readonly records: readonly DemandedRecord[];
}

function demandedRecord(value: unknown): value is Omit<DemandedRecord, 'verification'> {
  const r = record(value);
  return (
    r !== undefined &&
    hasStrings(r, ['objectId', 'objectType', 'title', 'classification']) &&
    RECORDED_QUERY_ID.test(r['objectId'] as string) &&
    nonNegativeInteger(r['distinctPersonCount']) &&
    r['distinctPersonCount'] > 0
  );
}

export function parseDemandReplay(value: unknown): DemandReplay {
  const body = record(value);
  if (
    body === undefined ||
    !nonNegativeInteger(body['replayed']) ||
    !nonNegativeInteger(body['counted']) ||
    typeof body['truncated'] !== 'boolean'
  ) {
    throw new Error('demand replay did not match contract');
  }
  return {
    replayed: body['replayed'],
    truncated: body['truncated'],
    counted: body['counted'],
    records: hitList(body['records'], demandedRecord).map(withVerification),
  };
}

/** `POST /search/demand/replay`: replay what people cleared lower asked, at the caller's ceiling. */
export async function replayOrganizationDemand(caller: Caller): Promise<DemandReplay> {
  const response = await fetch(`${apiBaseUrl()}/search/demand/replay`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: '{}',
    cache: 'no-store',
  });
  return decodeSuccessfulResponse(await parseResponse(response), parseDemandReplay);
}
