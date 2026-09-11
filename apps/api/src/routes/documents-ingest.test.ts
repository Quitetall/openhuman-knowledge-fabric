import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { digestBytes } from '@kf/canonicalization';
import type { Pool } from '@kf/database';
import { registerIngestRoute } from './documents/ingest-route.js';
import type { DocumentRoutesOptions } from './documents/contracts.js';

/**
 * `POST /ingest` is the CLI's copy path as a request a session can make: the bytes land
 * content-addressed, the upload is verified, and `attach_evidence` is dispatched with the
 * classification the caller states. What is asserted is exactly what a CLI ingest would have
 * written — the same payload — and that a malformed request never reaches the store.
 */

const ORG = '44444444-4444-7444-8444-444444444444';
const ACTOR = '55555555-5555-7555-8555-555555555555';
const ROLE = '66666666-6666-7666-8666-666666666666';
const FILE = Buffer.from('# Truck 7 maintenance log\n\nBrakes serviced.\n');

function pool(): Pool {
  return {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })),
    end: vi.fn(async () => undefined),
  } as unknown as Pool;
}

function options(
  store: InMemoryObjectStore | undefined,
  execute: DocumentRoutesOptions['executeInTransaction'],
): DocumentRoutesOptions {
  return {
    pool: pool(),
    store,
    identify: async () => ({
      actorId: ACTOR,
      actingRoleId: ROLE,
      organizationId: ORG,
      maxClassification: 'internal',
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
    preflightInTransaction: vi.fn(async () => undefined),
    executeInTransaction: execute,
  };
}

describe('POST /ingest', () => {
  it('stores the bytes content-addressed and dispatches attach_evidence with the stated classification', async () => {
    const store = new InMemoryObjectStore();
    const execute = vi.fn(async () => ({
      actionId: 'a1',
      status: 'applied' as const,
      replayed: false,
      objectIds: ['artifact-1'],
      auditDigest: 'd1',
    }));
    const app = Fastify({ logger: false });
    registerIngestRoute(
      app,
      options(store, execute as DocumentRoutesOptions['executeInTransaction']),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: {
        title: 'truck-7-maintenance-log.md',
        artifactKind: 'document',
        classification: 'internal',
        mediaType: 'text/markdown',
        contentBase64: FILE.toString('base64'),
        reason: 'routine fleet record',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      artifactId: 'artifact-1',
      actionId: 'a1',
      sha256: digestBytes(FILE),
      sizeBytes: FILE.length,
      classification: 'internal',
      replayed: false,
    });
    const request = (execute.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(request['actionType']).toBe('attach_evidence');
    expect(request['actorId']).toBe(ACTOR);
    expect(request['payload']).toEqual({
      classification: 'internal',
      title: 'truck-7-maintenance-log.md',
      artifact_kind: 'document',
      sha256: digestBytes(FILE),
      size_bytes: FILE.length,
      media_type: 'text/markdown',
      storage_uri: `ingest/${ORG}/${digestBytes(FILE)}`,
    });
    expect(request['reason']).toBe('routine fleet record');
    const stored = await store.read(`ingest/${ORG}/${digestBytes(FILE)}`, undefined, FILE.length);
    expect(stored).toEqual(FILE);
  });

  it('refuses a malformed request before touching the store', async () => {
    const store = new InMemoryObjectStore();
    const execute = vi.fn();
    const app = Fastify({ logger: false });
    registerIngestRoute(
      app,
      options(store, execute as DocumentRoutesOptions['executeInTransaction']),
    );
    for (const payload of [
      {
        artifactKind: 'document',
        classification: 'internal',
        mediaType: 'text/plain',
        contentBase64: 'aGk=',
      },
      {
        title: 't',
        artifactKind: 'report',
        classification: 'internal',
        mediaType: 'text/plain',
        contentBase64: 'aGk=',
      },
      {
        title: 't',
        artifactKind: 'document',
        classification: 'internal',
        mediaType: 'text/plain',
        contentBase64: '',
      },
      {
        title: 't',
        artifactKind: 'document',
        classification: 'internal',
        mediaType: 'text/plain',
        contentBase64: '***',
      },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/ingest', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers 503 rather than pretending when no store is configured', async () => {
    const app = Fastify({ logger: false });
    registerIngestRoute(
      app,
      options(undefined, vi.fn() as DocumentRoutesOptions['executeInTransaction']),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: {
        title: 't',
        artifactKind: 'document',
        classification: 'internal',
        mediaType: 'text/plain',
        contentBase64: 'aGk=',
      },
    });
    expect(response.statusCode).toBe(503);
  });
});
