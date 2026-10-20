import type { RankedSearchHit, SearchHit, SearchRequest, SearchResponse } from '../../lib/api';

const FILTER_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const QUERY_MAX_LENGTH = 512;
const FILTER_MAX_COUNT = 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export type SearchPageParams = Readonly<Record<string, string | readonly string[] | undefined>>;

export type ParsedSearchPage =
  | { readonly status: 'idle' | 'invalid' }
  | {
      readonly status: 'submitted';
      readonly request: SearchRequest;
      /** The "Search by meaning" switch. Shown list only; the API request is the same. */
      readonly meaning: boolean;
    };

function filterList(value: string | readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const submitted = typeof value === 'string' ? [value] : [...value];
  if (
    submitted.length === 0 ||
    submitted.length > FILTER_MAX_COUNT ||
    !submitted.every((candidate) => candidate === '' || FILTER_TOKEN.test(candidate))
  ) {
    throw new Error('invalid filter');
  }
  const values = submitted.filter((candidate) => candidate !== '');
  if (values.length === 0) return undefined;
  return [...new Set(values)];
}

function resultLimit(value: string | readonly string[] | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('invalid limit');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_LIMIT) throw new Error('invalid limit');
  return limit;
}

/** The near-miss checkbox: `true` when ticked, absent otherwise; anything else is refused. */
function nearMissFlag(value: string | readonly string[] | undefined): boolean {
  if (value === undefined) return false;
  if (value === 'true') return true;
  throw new Error('invalid nearMisses');
}

/**
 * The "Search by meaning" switch, as the URL carries it. On is the default, so an address without
 * the parameter (a shared link, a bookmark, a link from Home) searches by meaning.
 *
 * Without script the switch is a checkbox named `meaning` (value `on`) after a hidden `meaning=off`,
 * because an unticked checkbox sends nothing and nothing has to mean on: ticked sends both, in that
 * order, and the last one counts. With script only the hidden field is sent, and only when off.
 * Exactly those four shapes are accepted; `undefined` means the value was anything else.
 */
export function searchByMeaning(
  value: string | readonly string[] | undefined,
): boolean | undefined {
  if (value === undefined || value === 'on') return true;
  if (value === 'off') return false;
  if (typeof value !== 'string' && value.length === 2 && value[0] === 'off' && value[1] === 'on') {
    return true;
  }
  return undefined;
}

export function parseSearchPageParams(params: SearchPageParams): ParsedSearchPage {
  const query = params['q'];
  if (query === undefined) return { status: 'idle' };
  if (typeof query !== 'string' || query.length > QUERY_MAX_LENGTH) return { status: 'invalid' };
  try {
    const objectTypes = filterList(params['objectType']);
    const lifecycleStates = filterList(params['lifecycleState']);
    const nearMisses = nearMissFlag(params['nearMisses']);
    const meaning = searchByMeaning(params['meaning']);
    if (meaning === undefined) throw new Error('invalid meaning');
    return {
      status: 'submitted',
      meaning,
      request: {
        text: query,
        limit: resultLimit(params['limit']),
        ...(nearMisses ? { nearMisses } : {}),
        ...(objectTypes === undefined ? {} : { objectTypes }),
        ...(lifecycleStates === undefined ? {} : { lifecycleStates }),
      },
    };
  } catch {
    return { status: 'invalid' };
  }
}

/**
 * Where a hit leads. Types with a dedicated page go there; every other type has the Object View,
 * which renders any object in the ontology, so no hit is ever a dead end.
 */
export function recordHref(objectType: string, objectId: string): string {
  const encoded = encodeURIComponent(objectId);
  if (objectType === 'controlled_document') return `/documents/${encoded}`;
  if (objectType === 'initiative_project') return `/projects/${encoded}`;
  return `/objects/${encoded}`;
}

const SEARCH_PARAMS = [
  'q',
  'objectType',
  'lifecycleState',
  'limit',
  'nearMisses',
  'meaning',
] as const;

/**
 * The search page's own address, to come back to after signing in. A session lasts minutes, so
 * renewal is routine; returning to a bare `/search` would drop the query the person was reading.
 * Only the page's own parameters are kept, and the login route sanitizes the result again.
 */
export function searchReturnPath(params: SearchPageParams): string {
  const query = new URLSearchParams();
  for (const name of SEARCH_PARAMS) {
    const value = params[name];
    for (const entry of typeof value === 'string' ? [value] : (value ?? [])) {
      query.append(name, entry);
    }
  }
  const encoded = query.toString();
  return encoded === '' ? '/search' : `/search?${encoded}`;
}

/** Whether the engine's ranking took part in this answer. Its absence is never silent. */
export function meaningUnavailable(response: SearchResponse): boolean {
  return (
    response.semantic === undefined ||
    response.withheld.some((entry) => entry.reasonClass === 'semantic_ranking_unavailable')
  );
}

/**
 * The one list a person reads first, chosen by the switch.
 *
 * On: the fused list (meaning and words; KF-SAS-RQ-224), which is word matches alone when the
 * engine did not answer, and says so. Off: the lexical list, every record holding the words, with
 * its total. Both come from the same API answer, so the withheld count beside either is the same
 * number: the API counts it over the word-match set (ADR 0037), which is the off list's own match
 * set and the only part of the on list that the count ever covered. Nothing is counted here.
 */
export type ShownList =
  | {
      readonly kind: 'ranked';
      readonly ranking: string;
      readonly hits: readonly RankedSearchHit[];
      readonly meaningUnavailable: boolean;
    }
  | {
      readonly kind: 'lexical';
      readonly ranking: string;
      readonly hits: readonly SearchHit[];
      readonly total: number;
      readonly complete: boolean;
    };

export function shownList(response: SearchResponse, meaning: boolean): ShownList {
  if (!meaning) {
    const { ranking, hits, total, complete } = response.lexical;
    return { kind: 'lexical', ranking, hits, total, complete };
  }
  return {
    kind: 'ranked',
    ranking: response.ranked.ranking,
    hits: response.ranked.hits,
    meaningUnavailable: meaningUnavailable(response),
  };
}

/** The address of the full search page for a query from Home, keeping the switch. */
export function searchPageHref(query: string, meaning: boolean): string {
  const params = new URLSearchParams({ q: query });
  if (!meaning) params.set('meaning', 'off');
  return `/search?${params.toString()}`;
}
