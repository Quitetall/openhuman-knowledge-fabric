import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { ActionRejected } from '@kf/actions';
import { InMemoryObjectStore } from '@kf/artifacts';
import { digestBytes } from '@kf/canonicalization';
import type { Pool } from '@kf/database';
import { DocumentParseRefused } from '@kf/documents';
import { registerIngestRoute } from './documents/ingest-route.js';
import {
  DEFAULT_DOCUMENT_SOURCE_DOWNLOAD_MAX_BYTES,
  INGEST_BODY_LIMIT_BYTES,
  INGEST_MAX_SOURCE_BYTES,
  type DocumentRoutesOptions,
} from './documents/contracts.js';

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
  preflight: DocumentRoutesOptions['preflightInTransaction'] = vi.fn(async () => undefined),
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
    preflightInTransaction: preflight,
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

  const VALID = {
    title: 'truck-7-maintenance-log.md',
    artifactKind: 'document',
    classification: 'internal',
    mediaType: 'text/markdown',
    contentBase64: FILE.toString('base64'),
  };

  it('stores nothing when the act would be refused: authority is rehearsed before the put', async () => {
    // The bytes used to be written first and the act checked after, so every refused ingest
    // left an object behind that nothing referenced and nothing would ever remove.
    const store = new InMemoryObjectStore();
    const execute = vi.fn();
    const preflight = vi.fn(async () => {
      throw new ActionRejected('act_not_granted', 'this role may not attach evidence');
    });
    const app = Fastify({ logger: false });
    registerIngestRoute(
      app,
      options(store, execute as DocumentRoutesOptions['executeInTransaction'], preflight),
    );
    const response = await app.inject({ method: 'POST', url: '/ingest', payload: VALID });
    expect(response.statusCode, response.body).toBe(422);
    expect(preflight).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(await store.head(`ingest/${ORG}/${digestBytes(FILE)}`)).toBeUndefined();
  });

  it('stores nothing for a classification above the session ceiling', async () => {
    const store = new InMemoryObjectStore();
    const execute = vi.fn();
    const app = Fastify({ logger: false });
    registerIngestRoute(
      app,
      options(store, execute as DocumentRoutesOptions['executeInTransaction']),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: { ...VALID, classification: 'restricted' },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    expect(await store.head(`ingest/${ORG}/${digestBytes(FILE)}`)).toBeUndefined();
  });

  it('answers a parser refusal as 422 document_refused, not a 500', async () => {
    const store = new InMemoryObjectStore();
    const execute = vi.fn(async () => {
      throw new DocumentParseRefused('timeout', 'pandoc exceeded the 30000 ms parse deadline');
    });
    const app = Fastify({ logger: false });
    registerIngestRoute(
      app,
      options(store, execute as DocumentRoutesOptions['executeInTransaction']),
    );
    const response = await app.inject({ method: 'POST', url: '/ingest', payload: VALID });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'document_refused',
      detail: { reason: 'timeout' },
    });
  });

  it('refuses a secret-bearing file as content_refused without storing or echoing it', async () => {
    const store = new InMemoryObjectStore();
    const execute = vi.fn();
    const preflight = vi.fn(async () => undefined);
    const app = Fastify({ logger: false });
    registerIngestRoute(
      app,
      options(store, execute as DocumentRoutesOptions['executeInTransaction'], preflight),
    );
    const card = ['4111', '1111', '1111', '1111'].join('');
    const body = Buffer.from(`# Expenses\n\nCard ${card} was charged.\n`);
    const response = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: { ...VALID, contentBase64: body.toString('base64') },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'content_refused',
      detail: { rule: 'payment-card', line: 3 },
    });
    expect(response.body).not.toContain(card);
    expect(preflight).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await store.head(`ingest/${ORG}/${digestBytes(body)}`)).toBeUndefined();

    const dotenv = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: { ...VALID, title: '.env' },
    });
    expect(dotenv.statusCode).toBe(422);
    expect(dotenv.json()).toMatchObject({ error: 'content_refused', detail: { rule: 'dotfile' } });
  });

  it('carries derivedFrom into the act as derived_from, and refuses one that is not a uuid', async () => {
    const store = new InMemoryObjectStore();
    const execute = vi.fn(async () => ({
      actionId: 'a2',
      status: 'applied' as const,
      replayed: false,
      objectIds: ['artifact-2'],
      auditDigest: 'd2',
    }));
    const app = Fastify({ logger: false });
    registerIngestRoute(
      app,
      options(store, execute as DocumentRoutesOptions['executeInTransaction']),
    );
    const source = '01a0d662-55a3-7e90-be92-da9ffd827a4f';
    const response = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: { ...VALID, derivedFrom: source.toUpperCase() },
    });
    expect(response.statusCode, response.body).toBe(201);
    const request = (execute.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect((request['payload'] as Record<string, unknown>)['derived_from']).toBe(source);

    const refused = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: { ...VALID, derivedFrom: 'the pdf' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'invalid_ingest' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('takes a file up to the size it can be downloaded back at, and refuses one past it', async () => {
    // A scanned 15 MB PDF is ordinary; the 16 MiB JSON body limit this route used to share with
    // the import refused every file over ~12 MB before it reached the route at all.
    expect(INGEST_MAX_SOURCE_BYTES).toBe(DEFAULT_DOCUMENT_SOURCE_DOWNLOAD_MAX_BYTES);
    expect(INGEST_BODY_LIMIT_BYTES).toBeGreaterThan(Math.ceil(INGEST_MAX_SOURCE_BYTES / 3) * 4);
    const store = new InMemoryObjectStore();
    const execute = vi.fn(async () => ({
      actionId: 'a3',
      status: 'applied' as const,
      replayed: false,
      objectIds: ['artifact-3'],
      auditDigest: 'd3',
    }));
    const app = Fastify({ logger: false });
    registerIngestRoute(
      app,
      options(store, execute as DocumentRoutesOptions['executeInTransaction']),
    );
    const large = Buffer.alloc(15 * 1024 * 1024, 0x20);
    const accepted = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: { ...VALID, mediaType: 'application/pdf', contentBase64: large.toString('base64') },
    });
    expect(accepted.statusCode, accepted.body.slice(0, 200)).toBe(201);
    const tooLarge = Buffer.alloc(INGEST_MAX_SOURCE_BYTES + 1, 0x20);
    const refused = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: {
        ...VALID,
        mediaType: 'application/pdf',
        contentBase64: tooLarge.toString('base64'),
      },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'invalid_ingest' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
