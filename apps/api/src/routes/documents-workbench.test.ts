import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ActionRequest, ActionResult } from '@kf/actions';
import type { Pool } from '@kf/database';
import type { IdentifyCaller } from './actions.js';
import { registerDocumentRoutes } from './documents.js';

const DOCUMENT_ID = '11111111-1111-7111-8111-111111111111';
const TARGET_ID = '22222222-2222-7222-8222-222222222222';
const SUBJECT_ID = '33333333-3333-7333-8333-333333333333';
const REVISION_ID = '44444444-4444-7444-8444-444444444444';
const HOLDER_ID = '55555555-5555-7555-8555-555555555555';
const BASIS_ID = '66666666-6666-7666-8666-666666666666';
const BASIS_DIGEST = 'a'.repeat(64);
const SOURCE_DIGEST = 'b'.repeat(64);

function caller(): IdentifyCaller {
  return vi.fn(async () => ({
    actorId: '77777777-7777-7777-8777-777777777777',
    actingRoleId: '88888888-8888-7888-8888-888888888888',
    organizationId: '99999999-9999-7999-8999-999999999999',
    maxClassification: 'internal',
    authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
  }));
}

const targetRow = {
  target_object_id: TARGET_ID,
  target_kind: 'authored_fragment',
  subject_id: SUBJECT_ID,
  stable_key: 'document:target',
  document_policy: 'ordinary',
  base_revision_id: REVISION_ID,
  target_row_version: '7',
  classification: 'internal',
  holder_id: HOLDER_ID,
  holder_kind: 'fabric_native',
  fabric_artifact_version_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  git_repository: null,
  git_commit_sha: null,
  git_path: null,
  git_submodule_commit_sha: null,
  external_authority: null,
  external_revision: null,
  content_digest: SOURCE_DIGEST,
  media_type: 'text/markdown',
  basis_id: BASIS_ID,
  basis_digest: BASIS_DIGEST,
  effective_classification: 'internal',
  finalized_at: new Date('2026-08-15T12:00:00.000Z'),
  target_profiles: [{ target: 'html', capabilities: ['human_readable'] }],
};

function pool(rowsFor: (sql: string) => readonly Record<string, unknown>[]): Pool {
  const client = {
    query: vi.fn(async (sql: string) => ({ rows: rowsFor(sql) })),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function options(
  rowsFor: (sql: string) => readonly Record<string, unknown>[],
  executeInTransaction = vi.fn<(tx: unknown, request: ActionRequest) => Promise<ActionResult>>(
    async () => ({
      actionId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      status: 'applied',
      replayed: false,
      objectIds: [TARGET_ID],
      auditDigest: 'c'.repeat(64),
    }),
  ),
) {
  return {
    pool: pool(rowsFor),
    identify: caller(),
    store: undefined,
    preflightInTransaction: vi.fn(async () => undefined),
    executeInTransaction,
  };
}

describe('document workbench projection', () => {
  it('returns exact target, Basis, diagnostics, views, and semantic run diff', async () => {
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options((sql) => {
        if (sql.includes('/* document.workspace-targets */')) return [targetRow];
        if (sql.includes('/* document.workspace-runs */')) {
          return [
            {
              run_id: 'run-current',
              run_status: 'succeeded',
              draft_only: true,
              semantic_digest: 'd'.repeat(64),
              semantic_graph: { sections: [{ id: 'intro', text: 'new' }], policy: 'active' },
              diagnostics: [{ severity: 'warning', code: 'draft', message: 'Draft only' }],
              conversion_loss: [],
              recorded_at: new Date('2026-08-15T13:00:00.000Z'),
            },
          ];
        }
        if (sql.includes('/* document.workspace-successful-runs */')) {
          return [
            {
              run_id: 'run-current',
              run_status: 'succeeded',
              draft_only: true,
              semantic_digest: 'd'.repeat(64),
              semantic_graph: { sections: [{ id: 'intro', text: 'new' }], policy: 'active' },
              diagnostics: [{ severity: 'warning', code: 'draft', message: 'Draft only' }],
              conversion_loss: [],
              recorded_at: new Date('2026-08-15T13:00:00.000Z'),
            },
            {
              run_id: 'run-previous',
              run_status: 'succeeded',
              draft_only: true,
              semantic_digest: 'e'.repeat(64),
              semantic_graph: { sections: [{ id: 'intro', text: 'old' }] },
              diagnostics: [],
              conversion_loss: [],
              recorded_at: new Date('2026-08-15T12:30:00.000Z'),
            },
          ];
        }
        if (sql.includes('/* document.workspace-views */')) {
          return [
            {
              id: 'view-html',
              target: 'html',
              media_type: 'text/html',
              artifact_version_id: 'artifact-view-1',
              content_digest: 'f'.repeat(64),
              effective_classification: 'internal',
            },
          ];
        }
        if (sql.includes('/* document.workspace-composition-nodes */')) {
          return [
            {
              revision_id: '99999999-9999-7999-8999-999999999999',
              subject_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
              object_id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
              title: 'Constitution root',
              stable_key: 'openhuman.constitution.root',
              revision_digest: '1'.repeat(64),
              classification: 'internal',
              created_at: new Date('2026-08-15T12:05:00.000Z'),
            },
          ];
        }
        if (sql.includes('/* document.workspace-composition-inputs */')) {
          return [
            {
              composition_revision_id: '99999999-9999-7999-8999-999999999999',
              ordinal: 1,
              role: 'fragment',
              target_id: REVISION_ID,
              target_title: 'Authority',
              content_digest: SOURCE_DIGEST,
            },
          ];
        }
        if (sql.includes('/* document.workspace-navigation-links */')) {
          return [
            {
              id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
              relation_type: 'implements',
              direction: 'inbound',
              peer_object_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
              peer_object_type: 'adr_decision',
              peer_title: 'Document compiler ADR',
              recorded_at: new Date('2026-08-15T12:10:00.000Z'),
            },
          ];
        }
        if (sql.includes('/* document.workspace-adr-links */')) {
          return [
            {
              decision_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
              title: 'Document compiler ADR',
              lifecycle_state: 'accepted',
              latest_progress_kind: 'implemented',
              topic_key: 'documents',
            },
          ];
        }
        if (sql.includes('/* document.workspace-topic-links */')) return [];
        return [];
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${DOCUMENT_ID}/workbench`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      target: {
        kind: 'authored_fragment',
        objectId: TARGET_ID,
        baseRevisionId: REVISION_ID,
        rowVersion: '7',
      },
      basis: { id: BASIS_ID, digest: BASIS_DIGEST },
      compilation: { runId: 'run-current', status: 'succeeded', draftOnly: true },
      projections: [{ id: 'view-html', target: 'html', contentDigest: 'f'.repeat(64) }],
      composition: {
        nodes: [{ revisionId: '99999999-9999-7999-8999-999999999999' }],
        inputs: [{ ordinal: 1, role: 'fragment', targetId: REVISION_ID }],
      },
      navigation: {
        backlinks: [{ relationType: 'implements', peerTitle: 'Document compiler ADR' }],
        traceability: [{ relationType: 'implements', peerTitle: 'Document compiler ADR' }],
        adr: [{ title: 'Document compiler ADR', topicKey: 'documents' }],
      },
      semanticDiff: {
        status: 'available',
        fromRunId: 'run-previous',
        toRunId: 'run-current',
        changes: expect.arrayContaining([
          { kind: 'added', path: '/policy', after: 'active' },
          { kind: 'changed', path: '/sections/0/text', before: 'old', after: 'new' },
        ]),
      },
    });
  });

  it('keeps latest failure diagnostics while diffing the last two successful graphs', async () => {
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options((sql) => {
        if (sql.includes('/* document.workspace-targets */')) return [targetRow];
        if (sql.includes('/* document.workspace-runs */')) {
          return [
            {
              run_id: 'run-failed',
              run_status: 'failed',
              draft_only: true,
              semantic_digest: null,
              semantic_graph: null,
              diagnostics: [{ severity: 'error', code: 'parse', message: 'Parse failed' }],
              conversion_loss: [],
              recorded_at: new Date('2026-08-15T14:00:00.000Z'),
            },
          ];
        }
        if (sql.includes('/* document.workspace-successful-runs */')) {
          return [
            {
              run_id: 'run-succeeded-new',
              run_status: 'succeeded',
              draft_only: true,
              semantic_digest: 'd'.repeat(64),
              semantic_graph: { title: 'New' },
              diagnostics: [],
              conversion_loss: [],
              recorded_at: new Date('2026-08-15T13:00:00.000Z'),
            },
            {
              run_id: 'run-succeeded-old',
              run_status: 'succeeded',
              draft_only: true,
              semantic_digest: 'e'.repeat(64),
              semantic_graph: { title: 'Old' },
              diagnostics: [],
              conversion_loss: [],
              recorded_at: new Date('2026-08-15T12:00:00.000Z'),
            },
          ];
        }
        return [];
      }),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${DOCUMENT_ID}/workbench`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      compilation: {
        runId: 'run-failed',
        status: 'failed',
        diagnostics: [{ severity: 'error', code: 'parse', message: 'Parse failed' }],
      },
      semanticDiff: {
        status: 'available',
        fromRunId: 'run-succeeded-old',
        toRunId: 'run-succeeded-new',
        changes: [{ kind: 'changed', path: '/title', before: 'Old', after: 'New' }],
      },
    });
  });

  it('withholds target and Basis when more than one exact mapping is visible', async () => {
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options((sql) =>
        sql.includes('/* document.workspace-targets */')
          ? [targetRow, { ...targetRow, basis_id: 'another-basis' }]
          : [],
      ),
    );

    const response = await app.inject({
      method: 'GET',
      url: `/documents/${DOCUMENT_ID}/workbench`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ambiguous' });
  });
});

describe('POST /documents/:id/proposals', () => {
  it('dispatches only record_document_proposal with exact target and Basis preconditions', async () => {
    const execute = vi.fn(async (_tx: unknown, request: ActionRequest): Promise<ActionResult> => ({
      actionId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      status: 'applied',
      replayed: false,
      objectIds: [request.targetIds[0]!],
      auditDigest: 'c'.repeat(64),
    }));
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options(
        (sql) => (sql.includes('/* document.workspace-targets */') ? [targetRow] : []),
        execute,
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/proposals`,
      payload: {
        proposalId: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
        basisId: BASIS_ID,
        basisDigest: BASIS_DIGEST,
        targetObjectId: TARGET_ID,
        baseRevisionId: REVISION_ID,
        targetRowVersion: '7',
        proposalKind: 'source_patch',
        operation: {
          operation: 'replace_fragment_source',
          media_type: 'text/markdown',
          classification: 'internal',
          holder_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
          previous_holder_id: HOLDER_ID,
          holder: {
            kind: 'fabric_native',
            artifact_version_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
            content_digest: 'e'.repeat(64),
          },
        },
        idempotencyKey: 'web-proposal-1',
        reason: 'Review proposed source revision',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actionType: 'record_document_proposal',
        targetIds: [TARGET_ID],
        expectedVersion: 7,
        payload: expect.objectContaining({
          basis_id: BASIS_ID,
          base_fragment_revision_id: REVISION_ID,
          proposed_by_kind: 'human',
        }),
      }),
    );
  });

  it('dispatches composition input proposals with composition base preconditions', async () => {
    const execute = vi.fn(async (_tx: unknown, request: ActionRequest): Promise<ActionResult> => ({
      actionId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      status: 'applied',
      replayed: false,
      objectIds: [request.targetIds[0]!],
      auditDigest: 'c'.repeat(64),
    }));
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options(
        (sql) =>
          sql.includes('/* document.workspace-targets */')
            ? [{ ...targetRow, target_kind: 'document_composition' }]
            : [],
        execute,
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/proposals`,
      payload: {
        proposalId: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
        basisId: BASIS_ID,
        basisDigest: BASIS_DIGEST,
        targetObjectId: TARGET_ID,
        baseRevisionId: REVISION_ID,
        targetRowVersion: '7',
        proposalKind: 'semantic_operations',
        operation: {
          operation: 'replace_composition_inputs',
          classification: 'internal',
          holder_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
          previous_holder_id: HOLDER_ID,
          holder: {
            kind: 'fabric_native',
            artifact_version_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
            content_digest: 'e'.repeat(64),
          },
          inputs: [
            {
              ordinal: 1,
              role: 'fragment',
              fragment_revision_id: REVISION_ID,
            },
          ],
        },
        idempotencyKey: 'web-proposal-composition-1',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actionType: 'record_document_proposal',
        targetIds: [TARGET_ID],
        expectedVersion: 7,
        payload: expect.objectContaining({
          basis_id: BASIS_ID,
          proposal_kind: 'semantic_operations',
          base_composition_revision_id: REVISION_ID,
          operations: [
            expect.objectContaining({
              operation: 'replace_composition_inputs',
              inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: REVISION_ID }],
            }),
          ],
        }),
      }),
    );
  });

  it('rejects stale Basis claims before action dispatch', async () => {
    const execute = vi.fn();
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options(
        (sql) => (sql.includes('/* document.workspace-targets */') ? [targetRow] : []),
        execute,
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/proposals`,
      payload: {
        proposalId: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
        basisId: BASIS_ID,
        basisDigest: '0'.repeat(64),
        targetObjectId: TARGET_ID,
        baseRevisionId: REVISION_ID,
        targetRowVersion: '7',
        proposalKind: 'source_patch',
        operation: {},
        idempotencyKey: 'web-proposal-stale',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'stale_document_workspace' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed Holder identifiers before action dispatch', async () => {
    const execute = vi.fn();
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      options(
        (sql) => (sql.includes('/* document.workspace-targets */') ? [targetRow] : []),
        execute,
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/proposals`,
      payload: {
        proposalId: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
        basisId: BASIS_ID,
        basisDigest: BASIS_DIGEST,
        targetObjectId: TARGET_ID,
        baseRevisionId: REVISION_ID,
        targetRowVersion: '7',
        proposalKind: 'source_patch',
        operation: {
          operation: 'replace_fragment_source',
          media_type: 'text/markdown',
          classification: 'internal',
          holder_id: 'not-a-uuid',
          previous_holder_id: HOLDER_ID,
          holder: {
            kind: 'fabric_native',
            artifact_version_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
            content_digest: 'e'.repeat(64),
          },
        },
        idempotencyKey: 'web-proposal-invalid-holder',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_document_proposal' });
    expect(execute).not.toHaveBeenCalled();
  });
});
