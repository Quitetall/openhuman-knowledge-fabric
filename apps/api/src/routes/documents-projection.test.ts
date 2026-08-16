import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { digestOf, InMemoryObjectStore } from '@kf/artifacts';
import type { Pool } from '@kf/database';
import type { IdentifyCaller } from './actions.js';
import { registerDocumentRoutes } from './documents.js';

const DOCUMENT_ID = '11111111-1111-7111-8111-111111111111';
const VIEW_ID = '22222222-2222-7222-8222-222222222222';
const BASIS_ID = '33333333-3333-7333-8333-333333333333';
const BYTES = Buffer.from('<h1>Exact projection</h1>');

const target = {
  target_object_id: '44444444-4444-7444-8444-444444444444',
  subject_id: '55555555-5555-7555-8555-555555555555',
  base_revision_id: '66666666-6666-7666-8666-666666666666',
  target_row_version: '3',
  classification: 'internal',
  holder_id: '77777777-7777-7777-8777-777777777777',
  content_digest: 'a'.repeat(64),
  media_type: 'text/markdown',
  basis_id: BASIS_ID,
  basis_digest: 'b'.repeat(64),
  effective_classification: 'internal',
  finalized_at: new Date('2026-08-15T12:00:00.000Z'),
  target_profiles: [],
};

function identity(): IdentifyCaller {
  return vi.fn(async () => ({
    actorId: '88888888-8888-7888-8888-888888888888',
    actingRoleId: '99999999-9999-7999-8999-999999999999',
    organizationId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    maxClassification: 'internal',
    authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
  }));
}

function pool(rowsFor: (sql: string) => readonly Record<string, unknown>[]): Pool {
  const client = {
    query: vi.fn(async (sql: string) => ({ rows: rowsFor(sql) })),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function options(
  rowsFor: (sql: string) => readonly Record<string, unknown>[],
  store: InMemoryObjectStore,
) {
  return {
    pool: pool(rowsFor),
    identify: identity(),
    store,
    preflightInTransaction: vi.fn(async () => undefined),
    executeInTransaction: vi.fn(),
  };
}

describe('GET /documents/:id/projections/:viewId', () => {
  it('reads only the immutable projection version and verifies its digest', async () => {
    const store = new InMemoryObjectStore();
    const stored = await store.put('views/exact', BYTES, 'text/html');
    await store.put('views/exact', Buffer.from('newer bytes'), 'text/html');
    const read = vi.spyOn(store, 'read');
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options((sql) => {
        if (sql.includes('/* document.workspace-targets */')) return [target];
        if (sql.includes('/* document.projection-bytes */')) {
          return [
            {
              target: 'html',
              media_type: 'text/html',
              size_bytes: String(BYTES.byteLength),
              sha256: digestOf(BYTES),
              storage_uri: stored.key,
              storage_version: stored.versionId,
            },
          ];
        }
        return [];
      }, store),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${DOCUMENT_ID}/projections/${VIEW_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(BYTES);
    expect(read).toHaveBeenCalledWith(stored.key, stored.versionId, BYTES.byteLength);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not read a projection when the exact target and Basis are ambiguous', async () => {
    const store = new InMemoryObjectStore();
    const read = vi.spyOn(store, 'read');
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options(
        (sql) =>
          sql.includes('/* document.workspace-targets */')
            ? [target, { ...target, basis_id: 'another-basis' }]
            : [],
        store,
      ),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${DOCUMENT_ID}/projections/${VIEW_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses bytes that do not match the retained projection digest', async () => {
    const store = new InMemoryObjectStore();
    const stored = await store.put('views/tampered', BYTES, 'text/html');
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options((sql) => {
        if (sql.includes('/* document.workspace-targets */')) return [target];
        if (sql.includes('/* document.projection-bytes */')) {
          return [
            {
              target: 'html',
              media_type: 'text/html',
              size_bytes: String(BYTES.byteLength),
              sha256: '0'.repeat(64),
              storage_uri: stored.key,
              storage_version: stored.versionId,
            },
          ];
        }
        return [];
      }, store),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${DOCUMENT_ID}/projections/${VIEW_ID}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'projection_digest_mismatch' });
  });
});
