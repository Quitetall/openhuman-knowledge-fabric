/**
 * What the API's request log may say about a request, and about an error.
 *
 * Fastify's default request serializer logs `request.url` whole, query string included, so every
 * `GET /search?q=…` put the query text in `api.log`: outside `search.recorded_query`, the one
 * place the owner accepted query text for 90 days, and outside its sweep. The same line carried a
 * `/master-record-links/:token` capability, which grants a read to whoever holds it.
 *
 * So a request is logged as its ROUTE, never its URL: the pattern it matched (`/search`,
 * `/documents/:id`), the parameters of it that are record identifiers (UUIDs, which are not text),
 * and the NAMES of its query parameters, never their values. A request that matched no route is
 * logged without a path at all: its path is whatever the caller typed.
 *
 * An error is logged with its type, message, stack and the fields that name schema objects, but
 * not PostgreSQL's `detail`, `where` or `internalQuery`: `detail` is where the server quotes row
 * contents ("Failing row contains (…)"), so a constraint violation on a record put its title in
 * the log.
 */

import type { FastifyRequest } from 'fastify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** A query parameter NAME this API could have defined. Anything else is counted, not named. */
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/u;

export interface LoggedRequest {
  readonly [field: string]: unknown;
  readonly method: string;
  /** The route pattern matched, or null when none did. */
  readonly route: string | null;
  /** Route parameters whose values are UUIDs: the records a request was about. */
  readonly ids?: Readonly<Record<string, string>>;
  /** The query's parameter names, sorted; values are never logged. */
  readonly query?: readonly string[];
  readonly host?: string;
  readonly remoteAddress?: string;
  readonly remotePort?: number;
}

export function loggedRequest(request: FastifyRequest): LoggedRequest {
  const route = request.routeOptions?.url ?? null;
  const ids: Record<string, string> = {};
  if (route !== null && request.params !== null && typeof request.params === 'object') {
    for (const [name, value] of Object.entries(request.params as Record<string, unknown>)) {
      if (typeof value === 'string' && UUID.test(value)) ids[name] = value;
    }
  }
  const queryAt = request.url.indexOf('?');
  const names = new Set<string>();
  if (queryAt >= 0) {
    for (const name of new URLSearchParams(request.url.slice(queryAt + 1)).keys()) {
      names.add(PARAMETER_NAME.test(name) ? name : '[other]');
    }
  }
  return {
    method: request.method,
    route,
    ...(Object.keys(ids).length === 0 ? {} : { ids }),
    ...(names.size === 0 ? {} : { query: [...names].sort() }),
    ...(request.host === undefined ? {} : { host: request.host }),
    ...(request.ip === undefined ? {} : { remoteAddress: request.ip }),
    ...(request.socket?.remotePort === undefined ? {} : { remotePort: request.socket.remotePort }),
  };
}

/** PostgreSQL error fields that can quote data or SQL; everything else names the schema. */
const QUOTING_FIELDS: ReadonlySet<string> = new Set(['detail', 'where', 'internalQuery']);
const MAX_CAUSE_DEPTH = 5;

export interface LoggedError {
  [field: string]: unknown;
  type: string;
  message: string;
  stack: string;
}

export function loggedError(error: unknown, depth = 0): LoggedError {
  if (!(error instanceof Error)) {
    return {
      type: typeof error,
      message: typeof error === 'string' ? error : 'non-error thrown',
      stack: '',
    };
  }
  const out: LoggedError = {
    type: error.constructor.name,
    message: error.message,
    stack: error.stack ?? '',
  };
  for (const [key, value] of Object.entries(error)) {
    if (QUOTING_FIELDS.has(key) || key === 'cause') continue;
    if (value === undefined || typeof value === 'function') continue;
    // Scalars only: a nested object on an error is where a caller's payload would ride along.
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out['cause'] = loggedError(error.cause, depth + 1);
  }
  return out;
}

/** For `Fastify({ logger: { serializers } })`. */
export const requestLogSerializers = {
  req: loggedRequest,
  err: (error: unknown): LoggedError => loggedError(error),
};
