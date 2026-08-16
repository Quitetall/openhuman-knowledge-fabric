import { describe, expect, it } from 'vitest';
import type { DocumentProposalOperation } from '../../documents/src/proposal.js';
import {
  LamuProvider,
  planAiProposalContext,
  planAndDispatchAiProposal,
  recordDocumentProposalPayload,
  validateAiEvaluationResult,
  type AiContextCandidate,
  type AiContextPlannerInput,
  type AiContextPlannerRepository,
  type AiProvider,
  type AiProposalRequest,
  type AiRoutingPolicy,
} from './ai.js';
import { dispatchAiProposal, dispatchPlannedAiProposal } from './ai/dispatch.js';

const SHA256 = 'a'.repeat(64);
const CONTEXT_PROVENANCE_DIGEST = 'b'.repeat(64);
const SOURCE_DIGEST = 'c'.repeat(64);

const fragmentOperation: DocumentProposalOperation = {
  operation: 'replace_fragment_source',
  media_type: 'text/markdown',
  classification: 'internal',
  holder_id: 'holder-next',
  previous_holder_id: 'holder-current',
  holder: {
    kind: 'fabric_native',
    artifact_version_id: 'artifact-version-next',
    content_digest: SHA256,
  },
};

const request: AiProposalRequest = {
  requestId: 'request-01',
  basisId: 'basis-01',
  instruction: 'Clarify retention rule',
  classification: 'internal',
  tokenizer: 'cl100k_base',
  tokenBudget: 2_048,
  context: [
    {
      subjectId: 'document-01',
      revisionId: 'revision-01',
      classification: 'internal',
      kind: 'document',
      content: 'Retention is controlled by policy.',
      tokenCount: 12,
      provenanceDigest: CONTEXT_PROVENANCE_DIGEST,
    },
  ],
  omittedSubjectIds: ['document-restricted'],
};

const localPolicy: AiRoutingPolicy = {
  policyId: 'local-first-v1',
  localClassificationCeiling: 'restricted',
  remoteAllowlist: [],
};

function provider(
  locality: 'local' | 'remote',
  operation: DocumentProposalOperation = fragmentOperation,
): AiProvider {
  return {
    providerId: locality === 'local' ? 'lamu' : 'remote-provider',
    modelId: 'model-1',
    locality,
    propose: async () => ({
      summary: 'Clarifies rule',
      operations: [{ subjectId: 'document-01', precondition: 'revision-01', operation }],
    }),
  };
}

function candidate(
  subjectId: string,
  extras: Partial<AiContextCandidate> = {},
): AiContextCandidate {
  return {
    subjectId,
    revisionId: extras.revisionId ?? 'revision-01',
    classification: extras.classification ?? 'internal',
    kind: extras.kind ?? 'document',
    content: extras.content ?? `Context for ${subjectId}`,
    tokenCount: extras.tokenCount ?? 4,
    provenanceDigest: extras.provenanceDigest ?? SOURCE_DIGEST,
    sourceDigest: extras.sourceDigest ?? SOURCE_DIGEST,
    updatedAt: extras.updatedAt ?? '2026-08-15T00:00:00.000Z',
    verified: extras.verified ?? true,
    lexicalScore: extras.lexicalScore,
    vectorScore: extras.vectorScore,
    relationDepth: extras.relationDepth,
  };
}

function plannerInput(
  extras: Partial<AiContextPlannerInput> = {},
  scopeExtras: Partial<AiContextPlannerInput['scope']> = {},
): AiContextPlannerInput {
  return {
    scope: {
      organizationId: 'org-01',
      maxClassification: 'internal',
      actorId: 'actor-01',
      actingRoleId: 'role-01',
      ...scopeExtras,
    },
    requestId: 'request-planned-01',
    basisId: 'basis-01',
    instruction: 'Clarify retention rule',
    classification: 'internal',
    tokenizer: 'cl100k_base',
    tokenBudget: 15,
    query: 'retention policy',
    seedSubjectIds: ['document-01'],
    ...extras,
  };
}

describe('AI proposal routing', () => {
  it('keeps the compatibility dispatcher off the public AI barrel', async () => {
    const publicAi = (await import('./ai.js')) as Readonly<Record<string, unknown>>;

    expect(publicAi).not.toHaveProperty('dispatchAiProposal');
    expect(publicAi).not.toHaveProperty('dispatchPlannedAiProposal');
    expect(publicAi).toHaveProperty('planAndDispatchAiProposal');
  });

  it.each([
    ['scope organizationId', plannerInput({}, { organizationId: '' }), /scope organizationId/],
    [
      'scope maxClassification',
      plannerInput({}, { maxClassification: 'secret' as never }),
      /scope maxClassification/,
    ],
    ['scope actorId', plannerInput({}, { actorId: '' }), /scope actorId/],
    ['scope actingRoleId', plannerInput({}, { actingRoleId: '' }), /scope actingRoleId/],
    ['requestId', plannerInput({ requestId: '' }), /requestId/],
    ['basisId', plannerInput({ basisId: '' }), /basisId/],
    ['instruction', plannerInput({ instruction: '' }), /instruction/],
    ['instruction max', plannerInput({ instruction: 'x'.repeat(16_385) }), /instruction exceeds/],
    [
      'request classification',
      plannerInput({ classification: 'secret' as never }),
      /request classification/,
    ],
    [
      'request classification scope',
      plannerInput({ classification: 'confidential' }, { maxClassification: 'internal' }),
      /request classification exceeds planner scope/,
    ],
    ['tokenizer', plannerInput({ tokenizer: '' }), /tokenizer/],
    ['tokenBudget', plannerInput({ tokenBudget: 0 }), /token budget/],
    ['query max', plannerInput({ query: 'x'.repeat(4_097) }), /planner query exceeds/],
    [
      'seed count',
      plannerInput({ seedSubjectIds: Array.from({ length: 65 }, (_, index) => `seed-${index}`) }),
      /seedSubjectIds exceeds/,
    ],
    ['seedSubjectIds', plannerInput({ seedSubjectIds: [''] }), /seed subjectId/],
    [
      'seed duplicates',
      plannerInput({ seedSubjectIds: ['document-01', 'document-01'] }),
      /repeats/,
    ],
  ])('validates %s before repository search', async (_field, input, error) => {
    let invoked = false;
    const guarded: AiContextPlannerRepository = {
      authorizedLexicalCandidates: async () => {
        invoked = true;
        return [];
      },
      authorizedTypedRelationCandidates: async () => {
        invoked = true;
        return [];
      },
      authorizedDerivedVectorCandidates: async () => {
        invoked = true;
        return [];
      },
      authorizeSelectedCandidates: async () => {
        invoked = true;
        return [];
      },
    };

    await expect(planAiProposalContext(guarded, input)).rejects.toThrow(error);
    expect(invoked).toBe(false);
  });

  it('plans deterministic authorized context across lexical, relation, and vector channels', async () => {
    const authorizationCalls: AiContextCandidate[][] = [];
    const repository: AiContextPlannerRepository = {
      authorizedLexicalCandidates: async () => [
        candidate('document-01', {
          tokenCount: 10,
          lexicalScore: 0.92,
          provenanceDigest: CONTEXT_PROVENANCE_DIGEST,
          sourceDigest: CONTEXT_PROVENANCE_DIGEST,
        }),
        candidate('document-budget', { tokenCount: 12, lexicalScore: 0.89 }),
        candidate('document-auth-fail', { tokenCount: 5, lexicalScore: 0.88 }),
        candidate('document-secret', { classification: 'confidential', lexicalScore: 0.99 }),
      ],
      authorizedTypedRelationCandidates: async () => [
        candidate('document-01', {
          tokenCount: 10,
          relationDepth: 1,
          provenanceDigest: CONTEXT_PROVENANCE_DIGEST,
          sourceDigest: CONTEXT_PROVENANCE_DIGEST,
        }),
        candidate('document-01', { revisionId: 'revision-00', tokenCount: 4, relationDepth: 3 }),
      ],
      authorizedDerivedVectorCandidates: async () => [
        candidate('document-vector', { tokenCount: 2, vectorScore: 0.99 }),
      ],
      authorizeSelectedCandidates: async (_scope, candidates) => {
        authorizationCalls.push([...candidates]);
        return candidates.filter((item) => item.subjectId !== 'document-auth-fail');
      },
    };

    const plan = await planAiProposalContext(repository, plannerInput());

    expect(authorizationCalls.map((call) => call.map((item) => item.subjectId))).toEqual([
      ['document-01', 'document-auth-fail'],
      ['document-vector'],
    ]);
    expect(plan.request.context.map((item) => item.subjectId)).toEqual([
      'document-01',
      'document-vector',
    ]);
    expect(plan.selected.map((item) => [item.subjectId, item.revisionId])).toEqual([
      ['document-01', 'revision-01'],
      ['document-vector', 'revision-01'],
    ]);
    expect(plan.selected[0]).toMatchObject({
      channels: ['lexical', 'typed_relation'],
      provenanceDigest: CONTEXT_PROVENANCE_DIGEST,
      sourceDigest: CONTEXT_PROVENANCE_DIGEST,
    });
    expect(Object.isFrozen(plan.selected[0])).toBe(true);
    expect(plan.request.omittedSubjectIds).toEqual([
      'document-auth-fail',
      'document-budget',
      'document-secret',
    ]);
    expect(plan.omitted.map((item) => [item.subjectId, item.reason])).toEqual([
      ['document-01', 'duplicate_subject'],
      ['document-01', 'duplicate_subject'],
      ['document-auth-fail', 'not_authorized'],
      ['document-budget', 'token_budget'],
      ['document-secret', 'classification_ceiling'],
    ]);
  });

  it('rejects planned dispatch when the request did not come from the planner', async () => {
    let invoked = false;
    const guarded: AiProvider = {
      ...provider('local'),
      propose: async (input) => {
        invoked = true;
        return provider('local').propose(input);
      },
    };

    await expect(
      dispatchPlannedAiProposal(guarded, { request, selected: [], omitted: [] }, localPolicy),
    ).rejects.toThrow(/planner-produced request/);
    expect(invoked).toBe(false);
  });

  it('plans and dispatches only planner-selected context with exact proposal provenance', async () => {
    const providerRequests: AiProposalRequest[] = [];
    const repository: AiContextPlannerRepository = {
      authorizedLexicalCandidates: async () => [
        candidate('document-01', {
          content: request.context[0]!.content,
          tokenCount: 12,
          provenanceDigest: CONTEXT_PROVENANCE_DIGEST,
          sourceDigest: CONTEXT_PROVENANCE_DIGEST,
          lexicalScore: 0.9,
        }),
        candidate('document-extra', { tokenCount: 4, lexicalScore: 0.5 }),
      ],
      authorizedTypedRelationCandidates: async () => [],
      authorizeSelectedCandidates: async (_scope, candidates) =>
        candidates.filter((item) => item.subjectId === 'document-01'),
    };
    const guarded: AiProvider = {
      ...provider('local'),
      propose: async (input) => {
        providerRequests.push(input);
        return provider('local').propose(input);
      },
    };

    const { plan, result } = await planAndDispatchAiProposal(
      repository,
      guarded,
      {
        scope: {
          organizationId: 'org-01',
          maxClassification: 'internal',
          actorId: 'actor-01',
          actingRoleId: 'role-01',
        },
        requestId: request.requestId,
        basisId: request.basisId,
        instruction: request.instruction,
        classification: request.classification,
        tokenizer: request.tokenizer,
        tokenBudget: request.tokenBudget,
        query: 'retention policy',
        seedSubjectIds: ['document-01'],
      },
      localPolicy,
    );

    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]!.context.map((item) => item.subjectId)).toEqual(['document-01']);
    expect(providerRequests[0]!.omittedSubjectIds).toEqual(['document-extra']);
    expect(plan.omitted).toEqual([
      {
        subjectId: 'document-extra',
        revisionId: 'revision-01',
        reason: 'not_authorized',
        channels: ['lexical'],
        detail: 'candidate failed pre-dispatch authorization',
      },
    ]);
    await expect(
      dispatchPlannedAiProposal(guarded, { ...plan, request: { ...plan.request } }, localPolicy),
    ).rejects.toThrow(/planner-produced request/);
    expect(providerRequests).toHaveLength(1);
    expect(result.provenance).toMatchObject({
      request_id: 'request-01',
      basis_id: 'basis-01',
      provider: { provider_id: 'lamu', model_id: 'model-1', locality: 'local' },
      policy: {
        policy_id: 'local-first-v1',
        decision: { locality: 'local', classification_ceiling: 'restricted' },
      },
      context: {
        tokenizer: 'cl100k_base',
        token_budget: 2_048,
        included_items: [
          {
            subject_id: 'document-01',
            revision_id: 'revision-01',
            provenance_digest: CONTEXT_PROVENANCE_DIGEST,
          },
        ],
        omitted_subject_ids: ['document-extra'],
      },
    });
  });

  it('refuses dispatch when final authorization revokes a planned context candidate', async () => {
    const authorizationCalls: string[][] = [];
    const repository: AiContextPlannerRepository = {
      authorizedLexicalCandidates: async () => [
        candidate('document-01', {
          content: request.context[0]!.content,
          tokenCount: 12,
          provenanceDigest: CONTEXT_PROVENANCE_DIGEST,
          sourceDigest: CONTEXT_PROVENANCE_DIGEST,
          lexicalScore: 0.9,
        }),
      ],
      authorizedTypedRelationCandidates: async () => [],
      authorizeSelectedCandidates: async (_scope, candidates) => {
        authorizationCalls.push(candidates.map((item) => `${item.subjectId}:${item.revisionId}`));
        return authorizationCalls.length === 1 ? candidates : [];
      },
    };
    let invoked = false;
    const guarded: AiProvider = {
      ...provider('local'),
      propose: async (input) => {
        invoked = true;
        return provider('local').propose(input);
      },
    };

    await expect(
      planAndDispatchAiProposal(
        repository,
        guarded,
        plannerInput({
          requestId: request.requestId,
          basisId: request.basisId,
          instruction: request.instruction,
          tokenBudget: request.tokenBudget,
        }),
        localPolicy,
      ),
    ).rejects.toThrow(/final AI dispatch authorization drifted/);

    expect(authorizationCalls).toEqual([['document-01:revision-01'], ['document-01:revision-01']]);
    expect(invoked).toBe(false);
  });

  it('validates exact AI evaluation result metrics for retrieval, structure, leakage, and token cost', () => {
    const result = validateAiEvaluationResult({
      suiteId: 'eval-suite-01',
      basisId: 'basis-01',
      providerId: 'lamu',
      modelId: 'model-1',
      policyId: 'local-first-v1',
      tokenizer: 'cl100k_base',
      evaluatedAt: '2026-08-15T00:00:00.000Z',
      retrievalAccuracy: 0.99,
      referenceResolution: 1,
      structureTable: 0.97,
      graphOperations: 0.95,
      hallucination: 0,
      provenanceRetention: 1,
      leakage: 0,
      tokensPerSemanticFact: 18.5,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(result.tokensPerSemanticFact).toBe(18.5);
    expect(() => validateAiEvaluationResult({ ...result, leakage: 1.1 })).toThrow(
      /leakage must be between 0 and 1/,
    );
    expect(() => validateAiEvaluationResult({ ...result, extra: true })).toThrow(
      /unexpected fields/,
    );
  });

  it('records full local provider, policy, tokenizer, budget, and context provenance', async () => {
    const result = await dispatchAiProposal(provider('local'), request, localPolicy);

    expect(result).toMatchObject({
      status: 'proposal',
      provenance: {
        request_id: 'request-01',
        basis_id: 'basis-01',
        classification: 'internal',
        provider: { provider_id: 'lamu', model_id: 'model-1', locality: 'local' },
        policy: {
          policy_id: 'local-first-v1',
          decision: { locality: 'local', classification_ceiling: 'restricted' },
        },
        context: {
          tokenizer: 'cl100k_base',
          token_budget: 2_048,
          instruction_digest: '64dfec5e310a44ba8a283d5f9f7ccf44441d9cbd0fb16a05e697f4c9b1927902',
          included_items: [
            {
              subject_id: 'document-01',
              revision_id: 'revision-01',
              classification: 'internal',
              kind: 'document',
              token_count: 12,
              provenance_digest: CONTEXT_PROVENANCE_DIGEST,
            },
          ],
          omitted_subject_ids: ['document-restricted'],
        },
      },
    });
    expect(result.provenance.context.context_digest).toBe(
      '49853e71ba8f682cc846c2ad451d8777520def938f1821d0c93e0f8d6dc71ed1',
    );
    expect(result.provenance.context.included_items[0]?.content_digest).toBe(
      '811c761b862105f47145a81453ae4133f895e07bcf649f6444732c4c1d23e6a2',
    );
  });

  it('records the exact approved remote retention, training, and transport decision', async () => {
    const policy: AiRoutingPolicy = {
      ...localPolicy,
      remoteAllowlist: [
        {
          providerId: 'remote-provider',
          modelId: 'model-1',
          classificationCeiling: 'internal',
          retentionDays: 0,
          trainingUse: 'contractually_disabled',
          transportPolicy: 'private_endpoint',
        },
      ],
    };

    const result = await dispatchAiProposal(provider('remote'), request, policy);

    expect(result.provenance.policy.decision).toEqual({
      locality: 'remote',
      classification_ceiling: 'internal',
      retention_days: 0,
      training_use: 'contractually_disabled',
      transport_policy: 'private_endpoint',
    });
  });

  it('refuses remote dispatch unless provider, model, classification, retention, and training policy are allowlisted', async () => {
    await expect(dispatchAiProposal(provider('remote'), request, localPolicy)).rejects.toThrow(
      /not allowlisted/,
    );

    const policy: AiRoutingPolicy = {
      ...localPolicy,
      remoteAllowlist: [
        {
          providerId: 'remote-provider',
          modelId: 'model-1',
          classificationCeiling: 'public',
          retentionDays: 0,
          trainingUse: 'disabled',
          transportPolicy: 'tls_1_3',
        },
      ],
    };
    await expect(dispatchAiProposal(provider('remote'), request, policy)).rejects.toThrow(
      /classification ceiling/,
    );

    let invoked = false;
    const unsafeProvider: AiProvider = {
      ...provider('remote'),
      propose: async (input) => {
        invoked = true;
        return provider('remote').propose(input);
      },
    };
    const unsafeTrainingPolicy = {
      ...localPolicy,
      remoteAllowlist: [
        {
          providerId: 'remote-provider',
          modelId: 'model-1',
          classificationCeiling: 'restricted',
          retentionDays: 0,
          trainingUse: 'enabled',
          transportPolicy: 'tls_1_3',
        },
      ],
    } as unknown as AiRoutingPolicy;
    await expect(dispatchAiProposal(unsafeProvider, request, unsafeTrainingPolicy)).rejects.toThrow(
      /training use/,
    );
    expect(invoked).toBe(false);

    const unsafeTransportPolicy = {
      ...localPolicy,
      remoteAllowlist: [
        {
          providerId: 'remote-provider',
          modelId: 'model-1',
          classificationCeiling: 'restricted',
          retentionDays: 0,
          trainingUse: 'disabled',
          transportPolicy: 'plaintext',
        },
      ],
    } as unknown as AiRoutingPolicy;
    await expect(
      dispatchAiProposal(unsafeProvider, request, unsafeTransportPolicy),
    ).rejects.toThrow(/transport policy/);
    expect(invoked).toBe(false);
  });

  it('rejects model attempts to approve, publish, promote, or otherwise act', async () => {
    const unsafe = {
      ...provider('local'),
      propose: async () => ({
        summary: 'Attempts authority escalation',
        operations: [
          {
            subjectId: 'document-01',
            precondition: 'revision-01',
            operation: { operation: 'approve_document' },
          },
        ],
      }),
    } as unknown as AiProvider;

    await expect(dispatchAiProposal(unsafe, request, localPolicy)).rejects.toThrow(/not supported/);
  });

  it('rejects proposals aimed outside the exact authorized context revision', async () => {
    const outside: AiProvider = {
      ...provider('local'),
      propose: async () => ({
        summary: 'Crosses authority boundary',
        operations: [
          {
            subjectId: 'document-02',
            precondition: 'revision-01',
            operation: fragmentOperation,
          },
        ],
      }),
    };
    await expect(dispatchAiProposal(outside, request, localPolicy)).rejects.toThrow(
      /authorized context/,
    );

    const stale: AiProvider = {
      ...provider('local'),
      propose: async () => ({
        summary: 'Uses stale base',
        operations: [
          {
            subjectId: 'document-01',
            precondition: 'revision-00',
            operation: fragmentOperation,
          },
        ],
      }),
    };
    await expect(dispatchAiProposal(stale, request, localPolicy)).rejects.toThrow(
      /exact context revision/,
    );
  });

  it('requires exact tokenizer, token budget, and per-context provenance before dispatch', async () => {
    let invoked = false;
    const guarded: AiProvider = {
      ...provider('local'),
      propose: async (input) => {
        invoked = true;
        return provider('local').propose(input);
      },
    };

    await expect(
      dispatchAiProposal(guarded, { ...request, tokenizer: '' }, localPolicy),
    ).rejects.toThrow(/tokenizer/);
    await expect(
      dispatchAiProposal(guarded, { ...request, tokenBudget: 0 }, localPolicy),
    ).rejects.toThrow(/token budget/);
    await expect(
      dispatchAiProposal(
        guarded,
        {
          ...request,
          context: [{ ...request.context[0]!, provenanceDigest: 'not-a-digest' }],
        },
        localPolicy,
      ),
    ).rejects.toThrow(/provenance digest/);
    expect(invoked).toBe(false);
  });

  it('refuses an over-budget context before invoking the provider', async () => {
    let invoked = false;
    const guarded: AiProvider = {
      ...provider('local'),
      propose: async (input) => {
        invoked = true;
        return provider('local').propose(input);
      },
    };

    await expect(
      dispatchAiProposal(guarded, { ...request, tokenBudget: 11 }, localPolicy),
    ).rejects.toThrow(/context token count exceeds token budget/);
    expect(invoked).toBe(false);
  });

  it('bounds provider-facing text and requires one currently applyable operation', async () => {
    await expect(
      dispatchAiProposal(
        provider('local'),
        { ...request, instruction: 'x'.repeat(16_385) },
        localPolicy,
      ),
    ).rejects.toThrow(/instruction exceeds/);

    const excessive: AiProvider = {
      ...provider('local'),
      propose: async () => ({
        summary: 'Cannot be applied as one proposal',
        operations: [
          { subjectId: 'document-01', precondition: 'revision-01', operation: fragmentOperation },
          { subjectId: 'document-01', precondition: 'revision-01', operation: fragmentOperation },
        ],
      }),
    };
    await expect(dispatchAiProposal(excessive, request, localPolicy)).rejects.toThrow(
      /exactly one operation/,
    );
  });

  it('converts one result into the exact record_document_proposal payload without action authority', async () => {
    const result = await dispatchAiProposal(provider('local'), request, localPolicy);

    expect(recordDocumentProposalPayload({ proposalId: 'proposal-01', result })).toEqual({
      proposal_id: 'proposal-01',
      basis_id: 'basis-01',
      proposal_kind: 'source_patch',
      proposed_by_kind: 'model',
      model_provider: 'lamu',
      model_profile: 'model-1',
      model_request_id: 'request-01',
      base_fragment_revision_id: 'revision-01',
      operations: [fragmentOperation],
      model_provenance: result.provenance,
    });
    expect(recordDocumentProposalPayload({ proposalId: 'proposal-01', result })).not.toHaveProperty(
      'actionType',
    );
    expect(recordDocumentProposalPayload({ proposalId: 'proposal-01', result })).not.toHaveProperty(
      'actorId',
    );
  });

  it('maps a composition operation to semantic_operations and its exact base field', async () => {
    const operation: DocumentProposalOperation = {
      operation: 'replace_composition_inputs',
      classification: 'internal',
      holder_id: 'holder-next',
      previous_holder_id: 'holder-current',
      holder: {
        kind: 'external',
        authority: 'document-authority',
        revision: 'composition-source-2',
        content_digest: SHA256,
      },
      inputs: [{ ordinal: 1, role: 'binding', binding_id: 'binding-1' }],
    };
    const result = await dispatchAiProposal(provider('local', operation), request, localPolicy);

    expect(recordDocumentProposalPayload({ proposalId: 'proposal-02', result })).toMatchObject({
      proposal_kind: 'semantic_operations',
      base_composition_revision_id: 'revision-01',
      operations: [operation],
    });
    expect(recordDocumentProposalPayload({ proposalId: 'proposal-02', result })).not.toHaveProperty(
      'base_fragment_revision_id',
    );
  });

  it('provides a first-class LAMU adapter without granting tools or database access', async () => {
    const calls: unknown[] = [];
    const lamu = new LamuProvider({
      modelId: 'deepseek-v4-flash',
      invoke: async (input) => {
        calls.push(input);
        return {
          summary: 'Draft only',
          operations: [
            {
              subjectId: 'document-01',
              precondition: 'revision-01',
              operation: fragmentOperation,
            },
          ],
        };
      },
    });

    const result = await dispatchAiProposal(lamu, request, localPolicy);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('tools');
    expect(result.provenance.provider.provider_id).toBe('lamu');
  });
});
