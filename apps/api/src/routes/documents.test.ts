import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryObjectStore } from '@kf/artifacts';
import {
  ActionRejected,
  createTransactionalPreflight,
  type ActionRequest,
  type ActionResult,
  type ObjectRow,
} from '@kf/actions';
import type { Pool, Tx } from '@kf/database';
import { createDocumentActionAtoms } from '@kf/documents';
import type { IdentifyCaller } from './actions.js';
import { registerDocumentRoutes } from './documents.js';

const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '44444444-4444-7444-8444-444444444444';
const ROLE_ID = '55555555-5555-7555-8555-555555555555';
const ARTIFACT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const VERSION_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const FRAGMENT_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const FRAGMENT_REVISION_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const HOLDER_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
const DOCUMENT_ID = 'ffffffff-ffff-7fff-8fff-ffffffffffff';
const CURRENT_REVISION_ID = '99999999-9999-7999-8999-999999999999';
const CURRENT_HOLDER_ID = '88888888-8888-7888-8888-888888888888';
const SOURCE_BYTES = Buffer.from('# Constitution\n\nOne fact, one owner.');
const SOURCE_SHA256 = '57cdfdb134f641e575ec27308106f6f38064fe9184f223c1fc2258923d045049';
const STABLE_KEY =
  'document-import:22222222-2222-4222-8222-222222222222:03d135cf72528b621ee694d7c39e0022e5f0af3d13236449b22698e4cf0d9748';
const REVISION_DIGEST = '6'.repeat(64);

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function databaseBoundary(
  rowsFor: (sql: string, params: readonly unknown[]) => Record<string, unknown>[],
) {
  const calls: QueryCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: rowsFor(sql, params) };
    }),
    release: vi.fn(),
  };
  return {
    calls,
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
  };
}

function caller(): IdentifyCaller {
  return vi.fn(async () => ({
    actorId: ACTOR_ID,
    actingRoleId: ROLE_ID,
    organizationId: ORGANIZATION_ID,
    maxClassification: 'internal',
    authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
  }));
}

function importBody(idempotencyKey = 'api-document-dogfood-0001') {
  return {
    title: 'Dogfood Constitution',
    documentNumber: 'OH-DOC-TEST-HTTP-001',
    revision: 'R01',
    documentClass: 'specification',
    owningRole: 'technical_authority',
    fileName: 'constitution.txt',
    mediaType: 'text/plain',
    contentBase64: SOURCE_BYTES.toString('base64'),
    idempotencyKey,
  };
}

function actionResult(
  actionId: string,
  objectIds: readonly string[],
  replayed = false,
): ActionResult {
  return { actionId, objectIds, replayed, status: 'applied', auditDigest: 'audit' };
}

function controlledDocumentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOCUMENT_ID,
    title: 'Dogfood Constitution',
    document_number: 'OH-DOC-TEST-HTTP-001',
    revision: 'R01',
    document_class: 'specification',
    owning_role: 'technical_authority',
    content_version_id: VERSION_ID,
    ...overrides,
  };
}

describe('POST /documents fabric-native source', () => {
  it('rejects unauthorized document authority before immutable object storage', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('/* document.current-import-source */')) return [];
      if (sql.includes('registry.action_type')) {
        return [{ id: 'add_authored_fragment', transactional: true }];
      }
      if (sql.includes('registry.state_transition')) return [];
      if (sql.includes('org.holds_role')) return [{ ok: true }];
      if (sql.includes('from org.role_assignment')) {
        return [{ role_id: 'finance_approver', scope_id: ORGANIZATION_ID }];
      }
      return [];
    });
    const store = new InMemoryObjectStore();
    const putIfAbsent = vi.spyOn(store, 'putIfAbsent');
    const documentAtoms = createDocumentActionAtoms({
      store,
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const preflightInTransaction = createTransactionalPreflight({
      materializers: documentAtoms.materializers,
      preconditions: documentAtoms.preconditions,
    });
    const executeInTransaction = vi.fn();
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store,
      preflightInTransaction,
      executeInTransaction,
    });

    const response = await app.inject({ method: 'POST', url: '/documents', payload: importBody() });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'actor_not_authorized',
      detail: { rule: 'KF-DOC-AUTH-001' },
    });
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect(executeInTransaction).not.toHaveBeenCalled();
  });

  it('accepts an exact 10 MiB source through route-level validation', async () => {
    const db = databaseBoundary(() => []);
    const executeInTransaction = vi.fn(async () => {
      throw new ActionRejected('precondition_failed', 'fixture stops after body validation');
    });
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/documents',
      payload: {
        ...importBody('api-document-large-valid-01'),
        contentBase64: Buffer.alloc(10 * 1024 * 1024, 0x61).toString('base64'),
      },
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(executeInTransaction).toHaveBeenCalledOnce();
  });

  it('rejects a source one byte above 10 MiB before action execution', async () => {
    const db = databaseBoundary(() => []);
    const executeInTransaction = vi.fn();
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/documents',
      payload: {
        ...importBody('api-document-large-refused-01'),
        contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1, 0x61).toString('base64'),
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toEqual({
      error: 'invalid_document',
      message: 'document exceeds 10 MiB limit',
    });
    expect(executeInTransaction).not.toHaveBeenCalled();
  });

  it('refuses an occupied content-addressed key without overwriting its bytes', async () => {
    const db = databaseBoundary(() => []);
    const store = new InMemoryObjectStore();
    const key = `document-imports/${SOURCE_SHA256}`;
    const occupiedBytes = Buffer.alloc(SOURCE_BYTES.length, 0x78);
    const occupied = await store.put(key, occupiedBytes, 'application/octet-stream');
    const putIfAbsent = vi.spyOn(store, 'putIfAbsent');
    const executeInTransaction = vi.fn();
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store,
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction,
    });

    const response = await app.inject({ method: 'POST', url: '/documents', payload: importBody() });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toEqual({
      error: 'artifact_conflict',
      failure: 'digest_mismatch',
      message: 'stored bytes do not match the claimed digest',
    });
    expect(putIfAbsent).toHaveBeenCalledOnce();
    expect(executeInTransaction).not.toHaveBeenCalled();
    expect(await store.head(key)).toEqual(occupied);
    await expect(store.read(key, occupied.versionId)).resolves.toEqual(occupiedBytes);
  });

  it('creates an org-scoped Authored Fragment tied to exact controlled bytes', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('from content.artifact_version')) {
        return [{ id: VERSION_ID, sha256: SOURCE_SHA256, media_type: 'text/plain' }];
      }
      if (sql.includes('/* document.current-import-source */')) return [];
      if (sql.includes('/* document.source-by-action */')) {
        return [
          {
            fragment_id: FRAGMENT_ID,
            fragment_revision_id: FRAGMENT_REVISION_ID,
            holder_id: HOLDER_ID,
            revision_holder_id: HOLDER_ID,
            holder_kind: 'fabric_native',
            artifact_version_id: VERSION_ID,
            content_digest: SOURCE_SHA256,
            stable_key: STABLE_KEY,
            media_type: 'text/plain',
            classification: 'internal',
            document_policy: 'ordinary',
          },
        ];
      }
      if (sql.includes('/* document.imported-controlled-document */')) {
        return [controlledDocumentRow()];
      }
      return [];
    });
    const requests: ActionRequest[] = [];
    const execute = vi.fn(async (request: ActionRequest) => {
      requests.push(request);
      if (request.actionType === 'attach_evidence') {
        return actionResult('11111111-1111-7111-8111-111111111111', [ARTIFACT_ID]);
      }
      if (request.actionType === 'add_authored_fragment') {
        return actionResult('22222222-2222-7222-8222-222222222222', [FRAGMENT_ID]);
      }
      return actionResult('33333333-3333-7333-8333-333333333333', [DOCUMENT_ID]);
    });
    const store = new InMemoryObjectStore();
    const putIfAbsent = vi.spyOn(store, 'putIfAbsent');
    const preflightInTransaction = vi.fn(
      async (_tx: Tx, _request: ActionRequest, _objects: readonly ObjectRow[] = []) => undefined,
    );
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store,
      preflightInTransaction,
      executeInTransaction: async (_tx, request) => execute(request),
    });

    const response = await app.inject({ method: 'POST', url: '/documents', payload: importBody() });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: DOCUMENT_ID,
      artifactId: ARTIFACT_ID,
      fragmentId: FRAGMENT_ID,
      fragmentRevisionId: FRAGMENT_REVISION_ID,
      sha256: SOURCE_SHA256,
      replayed: false,
    });
    expect(requests.map((request) => request.actionType)).toEqual([
      'attach_evidence',
      'add_authored_fragment',
      'add_controlled_document',
    ]);
    expect(requests[1]).toMatchObject({
      targetIds: [],
      payload: {
        title: 'Dogfood Constitution',
        stable_key: STABLE_KEY,
        document_policy: 'ordinary',
        media_type: 'text/plain',
        classification: 'internal',
        holder: {
          kind: 'fabric_native',
          artifact_version_id: VERSION_ID,
          content_digest: SOURCE_SHA256,
        },
      },
    });
    expect(requests[2]).toMatchObject({ payload: { content_version: VERSION_ID } });
    expect(preflightInTransaction).toHaveBeenCalledOnce();
    expect(preflightInTransaction.mock.calls[0]?.[1]).toMatchObject({
      actionType: 'add_authored_fragment',
      targetIds: [],
      payload: { document_policy: 'ordinary' },
    });
    expect(preflightInTransaction.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        object_type: 'authored_fragment',
        organization_id: ORGANIZATION_ID,
      }),
    ]);
    expect(preflightInTransaction.mock.invocationCallOrder[0]!).toBeLessThan(
      putIfAbsent.mock.invocationCallOrder[0]!,
    );
    const lockIndex = db.calls.findIndex((call) => call.sql.includes('/* document.lock-import */'));
    const authoritativeLookupIndex = db.calls.findLastIndex((call) =>
      call.sql.includes('/* document.current-import-source */'),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(authoritativeLookupIndex);
    expect(
      requests.some((request) =>
        /approve|accept|publish|allocate|change_document_source_holder/.test(request.actionType),
      ),
    ).toBe(false);
  });

  it('revises same fabric authority and returns exact replayed source revision', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('from content.artifact_version')) {
        return [{ id: VERSION_ID, sha256: SOURCE_SHA256, media_type: 'text/plain' }];
      }
      if (sql.includes('/* document.current-import-source */')) {
        return [
          {
            fragment_id: FRAGMENT_ID,
            fragment_revision_id: CURRENT_REVISION_ID,
            holder_id: CURRENT_HOLDER_ID,
            revision_holder_id: CURRENT_HOLDER_ID,
            holder_kind: 'fabric_native',
            artifact_version_id: '77777777-7777-7777-8777-777777777777',
            content_digest: '7'.repeat(64),
            stable_key: STABLE_KEY,
            media_type: 'text/plain',
            classification: 'internal',
            document_policy: 'ordinary',
          },
        ];
      }
      if (sql.includes('/* document.source-by-action */')) {
        return [
          {
            fragment_id: FRAGMENT_ID,
            fragment_revision_id: FRAGMENT_REVISION_ID,
            holder_id: HOLDER_ID,
            revision_holder_id: HOLDER_ID,
            holder_kind: 'fabric_native',
            artifact_version_id: VERSION_ID,
            content_digest: SOURCE_SHA256,
            stable_key: STABLE_KEY,
            media_type: 'text/plain',
            classification: 'internal',
            document_policy: 'ordinary',
          },
        ];
      }
      if (sql.includes('/* document.imported-controlled-document */')) {
        return [controlledDocumentRow()];
      }
      return [];
    });
    const requests: ActionRequest[] = [];
    const execute = vi.fn(async (request: ActionRequest) => {
      requests.push(request);
      if (request.actionType === 'attach_evidence') {
        return actionResult('11111111-1111-7111-8111-111111111111', [ARTIFACT_ID], true);
      }
      if (request.actionType === 'revise_authored_fragment') {
        return actionResult('22222222-2222-7222-8222-222222222222', [FRAGMENT_ID], true);
      }
      return actionResult('33333333-3333-7333-8333-333333333333', [DOCUMENT_ID], true);
    });
    const preflightInTransaction = vi.fn(
      async (_tx: Tx, _request: ActionRequest, _objects: readonly ObjectRow[] = []) => undefined,
    );
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction,
      executeInTransaction: async (_tx, request) => execute(request),
    });

    const response = await app.inject({ method: 'POST', url: '/documents', payload: importBody() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fragmentId: FRAGMENT_ID,
      fragmentRevisionId: FRAGMENT_REVISION_ID,
      replayed: true,
    });
    expect(requests.map((request) => request.actionType)).toEqual([
      'attach_evidence',
      'revise_authored_fragment',
      'add_controlled_document',
    ]);
    expect(requests[1]).toMatchObject({
      targetIds: [FRAGMENT_ID],
      payload: {
        previous_revision_id: CURRENT_REVISION_ID,
        previous_holder_id: CURRENT_HOLDER_ID,
        holder: {
          kind: 'fabric_native',
          artifact_version_id: VERSION_ID,
          content_digest: SOURCE_SHA256,
        },
        media_type: 'text/plain',
        classification: 'internal',
      },
    });
    expect(requests[1]?.payload).not.toHaveProperty('document_policy');
    expect(preflightInTransaction).toHaveBeenCalledOnce();
    expect(preflightInTransaction.mock.calls[0]?.[1]).toMatchObject({
      actionType: 'revise_authored_fragment',
      targetIds: [FRAGMENT_ID],
    });
  });

  it('reuses exact current source instead of creating a duplicate revision', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('from content.artifact_version')) {
        return [{ id: VERSION_ID, sha256: SOURCE_SHA256, media_type: 'text/plain' }];
      }
      if (sql.includes('/* document.current-import-source */')) {
        return [
          {
            fragment_id: FRAGMENT_ID,
            fragment_revision_id: FRAGMENT_REVISION_ID,
            holder_id: HOLDER_ID,
            revision_holder_id: HOLDER_ID,
            holder_kind: 'fabric_native',
            artifact_version_id: VERSION_ID,
            content_digest: SOURCE_SHA256,
            stable_key: STABLE_KEY,
            media_type: 'text/plain',
            classification: 'internal',
            document_policy: 'ordinary',
          },
        ];
      }
      if (sql.includes('/* document.imported-controlled-document */')) {
        return [controlledDocumentRow()];
      }
      return [];
    });
    const requests: ActionRequest[] = [];
    const execute = vi.fn(async (request: ActionRequest) => {
      requests.push(request);
      return request.actionType === 'attach_evidence'
        ? actionResult('11111111-1111-7111-8111-111111111111', [ARTIFACT_ID], true)
        : actionResult('33333333-3333-7333-8333-333333333333', [DOCUMENT_ID], true);
    });
    const preflightInTransaction = vi.fn(
      async (_tx: Tx, _request: ActionRequest, _objects: readonly ObjectRow[] = []) => undefined,
    );
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction,
      executeInTransaction: async (_tx, request) => execute(request),
    });

    const response = await app.inject({ method: 'POST', url: '/documents', payload: importBody() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fragmentId: FRAGMENT_ID,
      fragmentRevisionId: FRAGMENT_REVISION_ID,
      replayed: true,
    });
    expect(requests.map((request) => request.actionType)).toEqual([
      'attach_evidence',
      'add_controlled_document',
    ]);
    expect(preflightInTransaction).not.toHaveBeenCalled();
  });

  it('refuses Holder transfer instead of converting external authority', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('from content.artifact_version')) return [{ id: VERSION_ID }];
      if (sql.includes('/* document.current-import-source */')) {
        return [
          {
            fragment_id: FRAGMENT_ID,
            fragment_revision_id: CURRENT_REVISION_ID,
            holder_id: CURRENT_HOLDER_ID,
            revision_holder_id: HOLDER_ID,
            holder_kind: 'external',
            artifact_version_id: null,
            content_digest: '7'.repeat(64),
            stable_key: STABLE_KEY,
            media_type: 'text/plain',
            classification: 'internal',
            document_policy: 'ordinary',
          },
        ];
      }
      return [];
    });
    const requests: ActionRequest[] = [];
    const execute = vi.fn(async (request: ActionRequest) => {
      requests.push(request);
      return actionResult('11111111-1111-7111-8111-111111111111', [ARTIFACT_ID]);
    });
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: async (_tx, request) => execute(request),
    });

    const response = await app.inject({ method: 'POST', url: '/documents', payload: importBody() });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'source_holder_conflict',
      message: 'Existing document source has another Holder; use explicit Holder migration.',
    });
    expect(requests).toEqual([]);
    expect(
      db.calls.find((call) => call.sql.includes('/* document.current-import-source */'))?.sql,
    ).not.toContain('r.holder_id = h.id');
  });

  it('refuses a replay key already bound to different artifact bytes', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('/* document.current-import-source */')) return [];
      if (sql.includes('from content.artifact_version')) {
        return [{ id: VERSION_ID, sha256: '7'.repeat(64), media_type: 'text/plain' }];
      }
      return [];
    });
    const requests: ActionRequest[] = [];
    const execute = vi.fn(async (request: ActionRequest) => {
      requests.push(request);
      return actionResult('11111111-1111-7111-8111-111111111111', [ARTIFACT_ID], true);
    });
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: async (_tx, request) => execute(request),
    });

    const response = await app.inject({ method: 'POST', url: '/documents', payload: importBody() });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'idempotency_conflict',
      message: 'Idempotency key already names a different document import.',
    });
    expect(requests.map((request) => request.actionType)).toEqual(['attach_evidence']);
  });

  it('refuses a fragment replay bound to another document subject', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('/* document.current-import-source */')) return [];
      if (sql.includes('from content.artifact_version')) {
        return [{ id: VERSION_ID, sha256: SOURCE_SHA256, media_type: 'text/plain' }];
      }
      if (sql.includes('/* document.source-by-action */')) {
        return [
          {
            fragment_id: FRAGMENT_ID,
            fragment_revision_id: FRAGMENT_REVISION_ID,
            holder_id: HOLDER_ID,
            revision_holder_id: HOLDER_ID,
            holder_kind: 'fabric_native',
            artifact_version_id: VERSION_ID,
            content_digest: SOURCE_SHA256,
            stable_key: 'document-import:another-organization:another-document',
            media_type: 'text/plain',
            classification: 'internal',
            document_policy: 'ordinary',
          },
        ];
      }
      return [];
    });
    const requests: ActionRequest[] = [];
    const execute = vi.fn(async (request: ActionRequest) => {
      requests.push(request);
      return request.actionType === 'attach_evidence'
        ? actionResult('11111111-1111-7111-8111-111111111111', [ARTIFACT_ID], true)
        : actionResult('22222222-2222-7222-8222-222222222222', [FRAGMENT_ID], true);
    });
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: async (_tx, request) => execute(request),
    });

    const response = await app.inject({ method: 'POST', url: '/documents', payload: importBody() });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'idempotency_conflict' });
    expect(requests.map((request) => request.actionType)).toEqual([
      'attach_evidence',
      'add_authored_fragment',
    ]);
  });

  it('refuses a controlled-document replay with different metadata', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('/* document.current-import-source */')) {
        return [
          {
            fragment_id: FRAGMENT_ID,
            fragment_revision_id: FRAGMENT_REVISION_ID,
            holder_id: HOLDER_ID,
            revision_holder_id: HOLDER_ID,
            holder_kind: 'fabric_native',
            artifact_version_id: VERSION_ID,
            content_digest: SOURCE_SHA256,
            stable_key: STABLE_KEY,
            media_type: 'text/plain',
            classification: 'internal',
            document_policy: 'ordinary',
          },
        ];
      }
      if (sql.includes('from content.artifact_version')) {
        return [{ id: VERSION_ID, sha256: SOURCE_SHA256, media_type: 'text/plain' }];
      }
      if (sql.includes('/* document.imported-controlled-document */')) {
        return [controlledDocumentRow({ title: 'Different prior title' })];
      }
      return [];
    });
    const requests: ActionRequest[] = [];
    const execute = vi.fn(async (request: ActionRequest) => {
      requests.push(request);
      return request.actionType === 'attach_evidence'
        ? actionResult('11111111-1111-7111-8111-111111111111', [ARTIFACT_ID], true)
        : actionResult('33333333-3333-7333-8333-333333333333', [DOCUMENT_ID], true);
    });
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: async (_tx, request) => execute(request),
    });

    const response = await app.inject({ method: 'POST', url: '/documents', payload: importBody() });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'idempotency_conflict' });
    expect(requests.map((request) => request.actionType)).toEqual([
      'attach_evidence',
      'add_controlled_document',
    ]);
  });
});

describe('GET /documents/:id source provenance', () => {
  it('exposes exact fabric-native source revision for controlled bytes', async () => {
    const db = databaseBoundary((sql) => {
      if (sql.includes('/* document.source-provenance */')) {
        return [
          {
            fragment_id: FRAGMENT_ID,
            fragment_revision_id: FRAGMENT_REVISION_ID,
            stable_key: 'openhuman.constitution.OH-DOC-TEST-HTTP-001',
            document_policy: 'ordinary',
            holder_id: HOLDER_ID,
            holder_kind: 'fabric_native',
            artifact_version_id: VERSION_ID,
            content_digest: SOURCE_SHA256,
            media_type: 'text/plain',
            classification: 'internal',
            revision_state: 'active',
            revision_digest: REVISION_DIGEST,
            holder_recorded_at: new Date('2026-08-14T12:00:00.000Z'),
            holder_recorded_by_action: '11111111-1111-7111-8111-111111111111',
            revision_created_at: new Date('2026-08-14T12:00:01.000Z'),
            revision_created_by_action: '22222222-2222-7222-8222-222222222222',
          },
        ];
      }
      if (sql.includes('join quality.controlled_document d')) {
        return [
          {
            id: DOCUMENT_ID,
            title: 'Dogfood Constitution',
            document_number: 'OH-DOC-TEST-HTTP-001',
            revision: 'R01',
            document_class: 'specification',
            lifecycle_state: 'draft',
            row_version: '1',
            owning_role: 'technical_authority',
            content_version_id: VERSION_ID,
            media_type: 'text/plain',
            sha256: SOURCE_SHA256,
            size_bytes: '37',
            parser: null,
            parser_version: null,
            content_digest: null,
            atom_count: '0',
            parse_id: null,
          },
        ];
      }
      return [];
    });
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: `/documents/${DOCUMENT_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: DOCUMENT_ID,
      contentVersionId: VERSION_ID,
      sourceProvenance: {
        status: 'recorded',
        holderKind: 'fabric_native',
        fragmentId: FRAGMENT_ID,
        fragmentRevisionId: FRAGMENT_REVISION_ID,
        stableKey: 'openhuman.constitution.OH-DOC-TEST-HTTP-001',
        documentPolicy: 'ordinary',
        holderId: HOLDER_ID,
        artifactVersionId: VERSION_ID,
        contentDigest: SOURCE_SHA256,
        mediaType: 'text/plain',
        classification: 'internal',
        revisionState: 'active',
        revisionDigest: REVISION_DIGEST,
        holderRecordedAt: '2026-08-14T12:00:00.000Z',
        holderRecordedByAction: '11111111-1111-7111-8111-111111111111',
        revisionCreatedAt: '2026-08-14T12:00:01.000Z',
        revisionCreatedByAction: '22222222-2222-7222-8222-222222222222',
      },
    });
  });

  it('does not invent source provenance when bytes have no unique Authored Fragment', async () => {
    const source = {
      fragment_id: FRAGMENT_ID,
      fragment_revision_id: FRAGMENT_REVISION_ID,
      stable_key: 'one',
      document_policy: 'ordinary',
      holder_id: HOLDER_ID,
      holder_kind: 'fabric_native',
      artifact_version_id: VERSION_ID,
      content_digest: SOURCE_SHA256,
      media_type: 'text/plain',
      classification: 'internal',
      revision_state: 'active',
      revision_digest: REVISION_DIGEST,
      holder_recorded_at: new Date('2026-08-14T12:00:00.000Z'),
      holder_recorded_by_action: '11111111-1111-7111-8111-111111111111',
      revision_created_at: new Date('2026-08-14T12:00:01.000Z'),
      revision_created_by_action: '22222222-2222-7222-8222-222222222222',
    };
    const db = databaseBoundary((sql) => {
      if (sql.includes('/* document.source-provenance */')) {
        return [source, { ...source, fragment_id: '77777777-7777-7777-8777-777777777777' }];
      }
      if (sql.includes('join quality.controlled_document d')) {
        return [
          {
            id: DOCUMENT_ID,
            title: 'Dogfood Constitution',
            document_number: 'OH-DOC-TEST-HTTP-001',
            revision: 'R01',
            document_class: 'specification',
            lifecycle_state: 'draft',
            row_version: '1',
            owning_role: 'technical_authority',
            content_version_id: VERSION_ID,
            media_type: 'text/plain',
            sha256: SOURCE_SHA256,
            size_bytes: '37',
            parser: null,
            parser_version: null,
            content_digest: null,
            atom_count: '0',
            parse_id: null,
          },
        ];
      }
      return [];
    });
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, {
      pool: db.pool,
      identify: caller(),
      store: new InMemoryObjectStore(),
      preflightInTransaction: vi.fn(async () => undefined),
      executeInTransaction: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: `/documents/${DOCUMENT_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sourceProvenance: { status: 'ambiguous' } });
    expect(response.json().sourceProvenance).not.toHaveProperty('fragmentId');
  });
});
