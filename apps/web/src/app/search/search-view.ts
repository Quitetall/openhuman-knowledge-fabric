import type { SearchRequest } from '../../lib/api';

const FILTER_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const QUERY_MAX_LENGTH = 512;
const FILTER_MAX_COUNT = 20;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export type SearchPageParams = Readonly<Record<string, string | readonly string[] | undefined>>;

export type ParsedSearchPage =
  | { readonly status: 'idle' | 'invalid' }
  | { readonly status: 'submitted'; readonly request: SearchRequest };

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

export function parseSearchPageParams(params: SearchPageParams): ParsedSearchPage {
  const query = params['q'];
  if (query === undefined) return { status: 'idle' };
  if (typeof query !== 'string' || query.length > QUERY_MAX_LENGTH) return { status: 'invalid' };
  try {
    const objectTypes = filterList(params['objectType']);
    const lifecycleStates = filterList(params['lifecycleState']);
    return {
      status: 'submitted',
      request: {
        text: query,
        limit: resultLimit(params['limit']),
        ...(objectTypes === undefined ? {} : { objectTypes }),
        ...(lifecycleStates === undefined ? {} : { lifecycleStates }),
      },
    };
  } catch {
    return { status: 'invalid' };
  }
}

export function recordHref(objectType: string, objectId: string): string | undefined {
  const encoded = encodeURIComponent(objectId);
  if (objectType === 'controlled_document') return `/documents/${encoded}`;
  if (objectType === 'initiative_project') return `/projects/${encoded}`;
  return undefined;
}
