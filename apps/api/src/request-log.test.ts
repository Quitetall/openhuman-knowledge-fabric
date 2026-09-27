import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

/**
 * The API's own logger, as `buildApp` configures it, never writes a query value, a path the caller
 * typed, a capability in a path, or the row contents PostgreSQL quotes in an error.
 *
 * Query text belongs in `search.recorded_query`, the one place the owner accepted it, for 90 days
 * and swept; `api.log` kept every `GET /search?q=…` URL outside that bound. Every line the logger
 * emits for these requests is captured, at the most verbose level, and searched for the values.
 */

const NEEDLE = 'tender-pricing-needle-7c1e';
const CAPABILITY = 'signed-capability-4b9a2f0d8e6c';
const ROW_TEXT = 'failing-row-title-needle-19ad';
const RECORD = '01930000-0000-7000-8000-0000000000aa';

async function logsOf(
  requests: readonly { method: 'GET' | 'POST'; url: string; payload?: unknown }[],
): Promise<string[]> {
  const lines: string[] = [];
  const app = await buildApp(
    loadConfig({ NODE_ENV: 'test', KF_DEPLOYMENT_PROFILE: 'development', LOG_LEVEL: 'trace' }),
    { logStream: { write: (line) => lines.push(line) } },
  );
  app.get('/master-record-links/:token', async () => ({ ok: true }));
  app.get('/documents/:id/probe', async () => ({ ok: true }));
  app.post('/probe', async () => {
    // What pg raises for a check violation: the row, title and all, in `detail`.
    throw Object.assign(new Error('new row for relation "object" violates check constraint'), {
      code: '23514',
      table: 'object',
      constraint: 'object_title_check',
      detail: `Failing row contains (…, ${ROW_TEXT}, …).`,
      where: `SQL statement "insert … ${ROW_TEXT}"`,
    });
  });
  for (const request of requests) {
    await app.inject({
      method: request.method,
      url: request.url,
      ...(request.payload === undefined ? {} : { payload: request.payload as object }),
    });
  }
  await app.close();
  return lines;
}

describe('the API request log', () => {
  it('names the route and the query parameters, never a query value', async () => {
    const lines = await logsOf([
      // Matched with a query; unmatched (no database here, so /search is not registered); a
      // capability in a path; a record id in a path; and a name that is itself free text.
      { method: 'GET', url: `/health?q=${NEEDLE}&limit=50` },
      { method: 'GET', url: `/search?q=${encodeURIComponent(`${NEEDLE} and more`)}` },
      { method: 'GET', url: `/master-record-links/${CAPABILITY}` },
      { method: 'GET', url: `/documents/${RECORD}/probe?view=${NEEDLE}` },
      { method: 'GET', url: `/health?${NEEDLE}%20words=1` },
      { method: 'GET', url: `/${NEEDLE}/typed/path` },
    ]);
    const log = lines.join('');
    expect(lines.length).toBeGreaterThanOrEqual(12);
    expect(log).not.toContain(NEEDLE);
    expect(log).not.toContain(CAPABILITY);

    const incoming = lines
      .map((line) => JSON.parse(line) as { msg: string; req?: Record<string, unknown> })
      .filter((line) => line.msg === 'incoming request')
      .map((line) => line.req);
    expect(incoming).toEqual([
      expect.objectContaining({ method: 'GET', route: '/health', query: ['limit', 'q'] }),
      expect.objectContaining({ method: 'GET', route: null, query: ['q'] }),
      expect.objectContaining({ method: 'GET', route: '/master-record-links/:token' }),
      expect.objectContaining({
        route: '/documents/:id/probe',
        ids: { id: RECORD },
        query: ['view'],
      }),
      expect.objectContaining({ route: '/health', query: ['[other]'] }),
      expect.objectContaining({ route: null }),
    ]);
    for (const request of incoming) expect(request).not.toHaveProperty('url');
  });

  it('logs an error by its type, message and schema names, never the row PostgreSQL quotes', async () => {
    const lines = await logsOf([{ method: 'POST', url: '/probe', payload: { title: NEEDLE } }]);
    const log = lines.join('');
    expect(log).not.toContain(ROW_TEXT);
    expect(log).not.toContain(NEEDLE);
    const errors = lines
      .map((line) => JSON.parse(line) as { err?: Record<string, unknown> })
      .filter((line) => line.err !== undefined);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.err).toMatchObject({
      type: 'Error',
      message: 'new row for relation "object" violates check constraint',
      code: '23514',
      table: 'object',
      constraint: 'object_title_check',
    });
  });
});
