import type { SearchQuery } from '@kf/search';

export const SEARCH_QUERY_MAX_LENGTH = 512;
export const SEARCH_FILTER_MAX_LENGTH = 64;
export const SEARCH_FILTER_MAX_COUNT = 20;
export const SEARCH_DEFAULT_LIMIT = 50;
export const SEARCH_MAX_LIMIT = 200;

const FILTER_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;

export class InvalidSearchQuery extends Error {
  constructor(readonly field: 'q' | 'objectType' | 'lifecycleState' | 'limit') {
    super(`invalid ${field}`);
    this.name = 'InvalidSearchQuery';
  }
}

type SearchQueryString = Readonly<Record<string, unknown>>;

function oneString(value: unknown, field: InvalidSearchQuery['field']): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidSearchQuery(field);
  return value;
}

function filterValues(
  value: unknown,
  field: 'objectType' | 'lifecycleState',
): string[] | undefined {
  if (value === undefined) return undefined;
  const submitted = Array.isArray(value) ? value : [value];
  if (
    submitted.length === 0 ||
    submitted.length > SEARCH_FILTER_MAX_COUNT ||
    !submitted.every(
      (candidate) =>
        typeof candidate === 'string' &&
        candidate.length <= SEARCH_FILTER_MAX_LENGTH &&
        (candidate === '' || FILTER_TOKEN.test(candidate)),
    )
  ) {
    throw new InvalidSearchQuery(field);
  }
  const values = (submitted as string[]).filter((candidate) => candidate !== '');
  return values.length === 0 ? undefined : [...new Set(values)];
}

function limitValue(value: unknown): number {
  const raw = oneString(value, 'limit');
  if (raw === undefined) return SEARCH_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new InvalidSearchQuery('limit');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > SEARCH_MAX_LIMIT) {
    throw new InvalidSearchQuery('limit');
  }
  return parsed;
}

export function parseSearchQuery(value: SearchQueryString): SearchQuery {
  const text = oneString(value['q'], 'q') ?? '';
  if (text.length > SEARCH_QUERY_MAX_LENGTH) throw new InvalidSearchQuery('q');
  const objectTypes = filterValues(value['objectType'], 'objectType');
  const lifecycleStates = filterValues(value['lifecycleState'], 'lifecycleState');
  return {
    text,
    limit: limitValue(value['limit']),
    ...(objectTypes === undefined ? {} : { objectTypes }),
    ...(lifecycleStates === undefined ? {} : { lifecycleStates }),
  };
}
