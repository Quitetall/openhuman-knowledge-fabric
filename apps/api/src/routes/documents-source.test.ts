import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { digestOf, InMemoryObjectStore } from '@kf/artifacts';
import type { Pool } from '@kf/database';
import type { IdentifyCaller } from './actions.js';
import { registerDocumentRoutes } from './documents.js';

const SOURCE = Buffer.from('# Exact source\n');
const DOCUMENT_ID = '11111111-1111-7111-8111-111111111111';

function caller(): IdentifyCaller {
  return vi.fn(async () => ({
    actorId: '22222222-2222-7222-8222-222222222222',
    actingRoleId: '33333333-3333-7333-8333-333333333333',
    organizationId: '44444444-4444-7444-8444-444444444444',
    maxClassification: 'internal',
    authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
  }));
}

function pool(row: Record<string, unknown> | undefined): Pool {
  const client = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('/* document.source-bytes */') && row !== undefined ? [row] : [],
    })),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

describe('GET /documents/:id/source', () => {
  it('reads the exact immutable storage version and verifies its digest', async () => {
    const store = new InMemoryObjectStore();
    const stored = await store.put('documents/source', SOURCE, 'text/markdown');
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: pool({
        document_number: 'OH-DOC-001',
        revision: 'R01',
        media_type: 'text/markdown',
        size_bytes: String(SOURCE.byteLength),
        sha256: digestOf(SOURCE),
        storage_uri: 'documents/source',
        storage_version: stored.versionId,
      }),
      identify: caller(),
      store,
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: `/documents/${DOCUMENT_ID}/source` });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(SOURCE);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers.etag).toBe(`"sha256:${digestOf(SOURCE)}"`);
  });

  it('fails closed when stored bytes no longer match the authoritative digest', async () => {
    const store = new InMemoryObjectStore();
    const stored = await store.put('documents/source', SOURCE, 'text/markdown');
    store.tamper('documents/source', Buffer.from('tampered source'));
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: pool({
        document_number: 'OH-DOC-001',
        revision: 'R01',
        media_type: 'text/markdown',
        size_bytes: String(Buffer.byteLength('tampered source')),
        sha256: digestOf(SOURCE),
        storage_uri: 'documents/source',
        storage_version: stored.versionId,
      }),
      identify: caller(),
      store,
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: `/documents/${DOCUMENT_ID}/source` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'source_digest_mismatch' });
  });

  it('refuses an oversized legacy row before object storage is read', async () => {
    const store = new InMemoryObjectStore();
    const read = vi.spyOn(store, 'read');
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: pool({
        document_number: 'OH-DOC-001',
        revision: 'R01',
        media_type: 'text/markdown',
        size_bytes: '21',
        sha256: digestOf(SOURCE),
        storage_uri: 'documents/source',
        storage_version: 'immutable-v1',
      }),
      identify: caller(),
      store,
      maxSourceDownloadBytes: 20,
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: `/documents/${DOCUMENT_ID}/source` });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: 'source_download_limit_exceeded' });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses an unversioned row without exposing its storage key', async () => {
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: pool({
        document_number: 'OH-DOC-001',
        revision: 'R01',
        media_type: 'text/markdown',
        size_bytes: String(SOURCE.byteLength),
        sha256: digestOf(SOURCE),
        storage_uri: 'secret/storage/key',
        storage_version: null,
      }),
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: `/documents/${DOCUMENT_ID}/source` });

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('secret/storage/key');
  });

  it('returns the same not-found response for absent and RLS-hidden records', async () => {
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: pool(undefined),
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: `/documents/${DOCUMENT_ID}/source` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });
});
