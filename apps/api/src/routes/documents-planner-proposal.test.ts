import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ActionRequest, ActionResult } from '@kf/actions';
import type { AiProvider, AiProviderResponse, AiRoutingPolicy } from '@kf/agent-tools';
import type { DocumentProposalOperation, ReplaceFragmentSourceOperation } from '@kf/documents';
import type { Pool } from '@kf/database';
import type { IdentifyCaller } from './actions.js';
import { registerDocumentRoutes } from './documents.js';

const DOCUMENT_ID = '11111111-1111-7111-8111-111111111111';
const TARGET_ID = '22222222-2222-7222-8222-222222222222';
const SUBJECT_ID = '33333333-3333-7333-8333-333333333333';
const REVISION_ID = '44444444-4444-7444-8444-444444444444';
const HOLDER_ID = '55555555-5555-7555-8555-555555555555';
const BASIS_ID = '66666666-6666-7666-8666-666666666666';
const PROPOSAL_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const NEXT_HOLDER_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const ARTIFACT_VERSION_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const BASIS_DIGEST = 'a'.repeat(64);
const SOURCE_DIGEST = 'b'.repeat(64);
const REVISION_DIGEST = 'c'.repeat(64);
const NEXT_DIGEST = 'd'.repeat(64);
const REQUEST_ID = 'planner-request-1';

const targetRow = {
  target_object_id: TARGET_ID,
  subject_id: SUBJECT_ID,
  base_revision_id: REVISION_ID,
  target_row_version: '7',
  classification: 'internal',
  holder_id: HOLDER_ID,
  content_digest: SOURCE_DIGEST,
  media_type: 'text/markdown',
  basis_id: BASIS_ID,
  basis_digest: BASIS_DIGEST,
  effective_classification: 'internal',
  finalized_at: new Date('2026-08-15T12:00:00.000Z'),
  target_profiles: [{ target: 'html', capabilities: ['human_readable'] }],
};

const contextRow = {
  subject_id: SUBJECT_ID,
  revision_id: REVISION_ID,
  classification: 'internal',
  content_digest: SOURCE_DIGEST,
  revision_digest: REVISION_DIGEST,
  media_type: 'text/markdown',
  stable_key: 'controlled:doc-001',
  title: 'Controlled document',
  updated_at: new Date('2026-08-15T12:00:00.000Z'),
  relation_depth: 0,
};

const policy: AiRoutingPolicy = {
  policyId: 'local-first-v1',
  localClassificationCeiling: 'restricted',
  remoteAllowlist: [],
};

function caller(): IdentifyCaller {
  return vi.fn(async () => ({
    actorId: '77777777-7777-7777-8777-777777777777',
    actingRoleId: '88888888-8888-7888-8888-888888888888',
    organizationId: '99999999-9999-7999-8999-999999999999',
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

function executeOk() {
  return vi.fn<(tx: unknown, request: ActionRequest) => Promise<ActionResult>>(
    async (_tx, request) => ({
      actionId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      status: 'applied',
      replayed: false,
      objectIds: [request.targetIds[0]!],
      auditDigest: 'e'.repeat(64),
    }),
  );
}

function provider(
  // Typed as the UNION, not inferred from the fragment default. Inference pinned it to a
  // `replace_fragment_source` shape, so the composition-inputs case below — a legitimate
  // second member, not a malformed value — read as an unknown property.
  operation: DocumentProposalOperation = fragmentOperation(),
  locality: 'local' | 'remote' = 'local',
) {
  return {
    providerId: locality === 'local' ? 'lamu' : 'remote-provider',
    modelId: 'model-1',
    locality,
    // The return type is annotated so the literal is checked against the real contract. An
    // unannotated literal widens `operation: 'replace_fragment_source'` to `string`, which is
    // how a mock can drift away from the interface it is standing in for.
    propose: vi.fn(async (): Promise<AiProviderResponse> => ({
      summary: 'Updates the controlled source.',
      operations: [{ subjectId: SUBJECT_ID, precondition: REVISION_ID, operation }],
    })),
  } satisfies AiProvider & { propose: ReturnType<typeof vi.fn> };
}

function options(
  rowsFor: (sql: string) => readonly Record<string, unknown>[],
  extras: Partial<{
    identify: IdentifyCaller;
    aiProposalProvider: AiProvider;
    aiRoutingPolicy: AiRoutingPolicy;
    executeInTransaction: ReturnType<typeof executeOk>;
  }> = {},
) {
  return {
    pool: pool(rowsFor),
    identify: extras.identify ?? caller(),
    store: undefined,
    preflightInTransaction: vi.fn(async () => undefined),
    executeInTransaction: extras.executeInTransaction ?? executeOk(),
    ...(extras.aiProposalProvider === undefined
      ? {}
      : { aiProposalProvider: extras.aiProposalProvider }),
    ...(extras.aiRoutingPolicy === undefined ? {} : { aiRoutingPolicy: extras.aiRoutingPolicy }),
  };
}

function plannerRows(sql: string): readonly Record<string, unknown>[] {
  if (sql.includes('/* document.workspace-targets */')) return [targetRow];
  if (sql.includes('/* document.ai-seed-context */')) return [contextRow];
  if (sql.includes('/* document.ai-lexical-context */')) return [];
  if (sql.includes('/* document.ai-authorize-context */')) return [contextRow];
  return [];
}

function fragmentOperation(
  overrides: Partial<ReplaceFragmentSourceOperation> = {},
): ReplaceFragmentSourceOperation {
  return {
    operation: 'replace_fragment_source',
    media_type: 'text/markdown',
    classification: 'internal',
    holder_id: NEXT_HOLDER_ID,
    previous_holder_id: HOLDER_ID,
    holder: {
      kind: 'fabric_native',
      artifact_version_id: ARTIFACT_VERSION_ID,
      content_digest: NEXT_DIGEST,
    },
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: PROPOSAL_ID,
    basisId: BASIS_ID,
    basisDigest: BASIS_DIGEST,
    targetObjectId: TARGET_ID,
    baseRevisionId: REVISION_ID,
    targetRowVersion: 7,
    instruction: 'Prepare a precise source clarification.',
    query: 'controlled source',
    tokenizer: 'cl100k_base',
    tokenBudget: 2_048,
    seedSubjectIds: [SUBJECT_ID],
    idempotencyKey: 'planner-proposal-1',
    reason: 'AI planner proposal',
    ...overrides,
  };
}

async function appWith(routeOptions: ReturnType<typeof options>) {
  const app = Fastify({ logger: false, genReqId: () => REQUEST_ID });
  await registerDocumentRoutes(app, routeOptions);
  return app;
}

describe('POST /documents/:id/planner/proposal', () => {
  it('requires authentication before planner availability checks', async () => {
    const app = await appWith(
      options(plannerRows, { identify: vi.fn(async () => Promise.reject(new Error('no auth'))) }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/planner/proposal`,
      payload: validBody(),
    });

    expect(response.statusCode).toBe(401);
  });

  it('fails closed when provider or routing policy is not configured', async () => {
    const app = await appWith(options(plannerRows));

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/planner/proposal`,
      payload: validBody(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'ai_planner_unavailable' });
  });

  it('rejects stale Basis and revision claims before provider invocation', async () => {
    const aiProvider = provider();
    const execute = executeOk();
    const app = await appWith(
      options(plannerRows, {
        aiProposalProvider: aiProvider,
        aiRoutingPolicy: policy,
        executeInTransaction: execute,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/planner/proposal`,
      payload: validBody({ basisDigest: '0'.repeat(64) }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'stale_document_workspace' });
    expect(aiProvider.propose).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['instruction', { instruction: 'x'.repeat(16_385) }],
    ['query', { query: 'x'.repeat(4_097) }],
    ['tokenBudget', { tokenBudget: 32_769 }],
    [
      'seedSubjectIds',
      {
        seedSubjectIds: Array.from(
          { length: 65 },
          (_, index) => `10000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        ),
      },
    ],
  ])('bounds planner %s before provider invocation', async (_field, override) => {
    const aiProvider = provider();
    const execute = executeOk();
    const app = await appWith(
      options(plannerRows, {
        aiProposalProvider: aiProvider,
        aiRoutingPolicy: policy,
        executeInTransaction: execute,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/planner/proposal`,
      payload: validBody(override),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_ai_planner_request' });
    expect(aiProvider.propose).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('denies disallowed provider routing policy before provider invocation', async () => {
    const aiProvider = provider(fragmentOperation(), 'remote');
    const execute = executeOk();
    const app = await appWith(
      options(plannerRows, {
        aiProposalProvider: aiProvider,
        aiRoutingPolicy: policy,
        executeInTransaction: execute,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/planner/proposal`,
      payload: validBody(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'ai_provider_policy_denied' });
    expect(aiProvider.propose).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects final operations outside the exact authored fragment target', async () => {
    const aiProvider = provider({
      operation: 'replace_composition_inputs',
      classification: 'internal',
      holder_id: NEXT_HOLDER_ID,
      previous_holder_id: HOLDER_ID,
      holder: {
        kind: 'fabric_native',
        artifact_version_id: ARTIFACT_VERSION_ID,
        content_digest: NEXT_DIGEST,
      },
      inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: REVISION_ID }],
    });
    const execute = executeOk();
    const app = await appWith(
      options(plannerRows, {
        aiProposalProvider: aiProvider,
        aiRoutingPolicy: policy,
        executeInTransaction: execute,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/planner/proposal`,
      payload: validBody(),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'invalid_ai_proposal' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks selected context authorization immediately before provider dispatch', async () => {
    const aiProvider = provider();
    const execute = executeOk();
    let authorizationChecks = 0;
    const app = await appWith(
      options(
        (sql) => {
          if (!sql.includes('/* document.ai-authorize-context */')) return plannerRows(sql);
          authorizationChecks += 1;
          return authorizationChecks === 1 ? [contextRow] : [];
        },
        {
          aiProposalProvider: aiProvider,
          aiRoutingPolicy: policy,
          executeInTransaction: execute,
        },
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/planner/proposal`,
      payload: validBody(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'planner_context_authorization_drift' });
    expect(aiProvider.propose).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('records model provenance and dispatches only record_document_proposal', async () => {
    const aiProvider = provider();
    const execute = executeOk();
    const app = await appWith(
      options(plannerRows, {
        aiProposalProvider: aiProvider,
        aiRoutingPolicy: policy,
        executeInTransaction: execute,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/planner/proposal`,
      payload: validBody(),
    });

    expect(response.statusCode).toBe(201);
    expect(execute).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0]![1];
    expect(request.actionType).toBe('record_document_proposal');
    expect(request.targetIds).toEqual([TARGET_ID]);
    expect(request.expectedVersion).toBe(7);
    expect(request.payload).toMatchObject({
      proposal_id: PROPOSAL_ID,
      basis_id: BASIS_ID,
      proposal_kind: 'source_patch',
      proposed_by_kind: 'model',
      model_provider: 'lamu',
      model_profile: 'model-1',
      model_request_id: REQUEST_ID,
      base_fragment_revision_id: REVISION_ID,
      model_provenance: {
        request_id: REQUEST_ID,
        basis_id: BASIS_ID,
        provider: { provider_id: 'lamu', model_id: 'model-1', locality: 'local' },
        policy: { policy_id: 'local-first-v1' },
        context: {
          included_items: [
            expect.objectContaining({
              subject_id: SUBJECT_ID,
              revision_id: REVISION_ID,
              provenance_digest: REVISION_DIGEST,
            }),
          ],
        },
      },
    });
    expect(request.payload?.['operations']).toEqual([fragmentOperation()]);
    expect(aiProvider.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        basisId: BASIS_ID,
        context: [expect.objectContaining({ subjectId: SUBJECT_ID, revisionId: REVISION_ID })],
      }),
    );
  });

  it('refuses model attempts to mutate source authority fields', async () => {
    const aiProvider = provider(fragmentOperation({ previous_holder_id: NEXT_HOLDER_ID }));
    const execute = executeOk();
    const app = await appWith(
      options(plannerRows, {
        aiProposalProvider: aiProvider,
        aiRoutingPolicy: policy,
        executeInTransaction: execute,
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/documents/${DOCUMENT_ID}/planner/proposal`,
      payload: validBody(),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'invalid_ai_proposal' });
    expect(execute).not.toHaveBeenCalled();
  });
});
