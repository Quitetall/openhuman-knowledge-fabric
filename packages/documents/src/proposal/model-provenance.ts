import { digest } from '@kf/canonicalization';

import {
  DOCUMENT_PROPOSAL_CONTEXT_FORMAT,
  type DocumentProposalContextKind,
  type DocumentProposalContextProjection,
  type DocumentProposalIncludedContextProvenance,
  type DocumentProposalModelProvenance,
  type DocumentProposalProviderPolicyDecision,
} from './contracts.js';
import {
  atOrBelow,
  classification,
  exactKeys,
  nonEmpty,
  nonnegativeSafeInteger,
  positiveOrdinal,
  record,
  sha256,
} from './validation.js';

const CONTEXT_KINDS = new Set<DocumentProposalContextKind>([
  'document',
  'metric_summary',
  'record',
]);

function providerPolicyDecision(value: unknown): DocumentProposalProviderPolicyDecision {
  const decision = record(value, 'model provenance policy decision');
  if (decision['locality'] === 'local') {
    exactKeys(
      decision,
      ['locality', 'classification_ceiling'],
      'local model provenance policy decision',
    );
    return Object.freeze({
      locality: decision['locality'],
      classification_ceiling: classification(decision['classification_ceiling']),
    });
  }
  if (decision['locality'] === 'remote') {
    exactKeys(
      decision,
      ['locality', 'classification_ceiling', 'retention_days', 'training_use', 'transport_policy'],
      'remote model provenance policy decision',
    );
    if (
      decision['training_use'] !== 'disabled' &&
      decision['training_use'] !== 'contractually_disabled'
    ) {
      throw new Error('model provenance remote training_use is not supported');
    }
    if (
      decision['transport_policy'] !== 'tls_1_3' &&
      decision['transport_policy'] !== 'private_endpoint'
    ) {
      throw new Error('model provenance remote transport_policy is not supported');
    }
    return Object.freeze({
      locality: decision['locality'],
      classification_ceiling: classification(decision['classification_ceiling']),
      retention_days: nonnegativeSafeInteger(
        decision['retention_days'],
        'model provenance remote retention_days',
      ),
      training_use: decision['training_use'],
      transport_policy: decision['transport_policy'],
    });
  }
  throw new Error('model provenance policy decision locality is not supported');
}

function includedContextProvenance(
  value: unknown,
  index: number,
): DocumentProposalIncludedContextProvenance {
  const item = record(value, `model provenance context.included_items[${String(index)}]`);
  exactKeys(
    item,
    [
      'subject_id',
      'revision_id',
      'classification',
      'kind',
      'token_count',
      'content_digest',
      'provenance_digest',
    ],
    `model provenance context.included_items[${String(index)}]`,
  );
  if (
    typeof item['kind'] !== 'string' ||
    !CONTEXT_KINDS.has(item['kind'] as DocumentProposalContextKind)
  ) {
    throw new Error(
      `model provenance context.included_items[${String(index)}].kind is not supported`,
    );
  }
  return Object.freeze({
    subject_id: nonEmpty(
      item['subject_id'],
      `model provenance context.included_items[${String(index)}].subject_id`,
    ),
    revision_id: nonEmpty(
      item['revision_id'],
      `model provenance context.included_items[${String(index)}].revision_id`,
    ),
    classification: classification(item['classification']),
    kind: item['kind'] as DocumentProposalContextKind,
    token_count: positiveOrdinal(
      item['token_count'],
      `model provenance context.included_items[${String(index)}].token_count`,
    ),
    content_digest: sha256(
      item['content_digest'],
      `model provenance context.included_items[${String(index)}].content_digest`,
    ),
    provenance_digest: sha256(
      item['provenance_digest'],
      `model provenance context.included_items[${String(index)}].provenance_digest`,
    ),
  });
}

function omittedSubjectIds(value: readonly unknown[], includedSubjects: Set<string>): string[] {
  const omitted = new Set<string>();
  return value.map((subjectId) => {
    const normalized = nonEmpty(subjectId, 'model provenance omitted subject_id');
    if (includedSubjects.has(normalized)) {
      throw new Error('model provenance subject cannot be both included and omitted');
    }
    if (omitted.has(normalized)) {
      throw new Error(`model provenance omitted subjects repeat ${normalized}`);
    }
    omitted.add(normalized);
    return normalized;
  });
}

function contextProjection(value: unknown): DocumentProposalContextProjection {
  const projection = record(value, 'model provenance context.projection');
  exactKeys(
    projection,
    ['definition_id', 'definition_version', 'corpus_digest', 'projection_digest'],
    'model provenance context.projection',
  );
  if (projection['definition_id'] !== 'agent_context') {
    throw new Error('model provenance context.projection must be the agent_context projection');
  }
  return Object.freeze({
    definition_id: 'agent_context',
    definition_version: positiveOrdinal(
      projection['definition_version'],
      'model provenance context.projection.definition_version',
    ),
    corpus_digest: sha256(
      projection['corpus_digest'],
      'model provenance context.projection.corpus_digest',
    ),
    projection_digest: sha256(
      projection['projection_digest'],
      'model provenance context.projection.projection_digest',
    ),
  });
}

/**
 * The digest of a model proposal's context claim (KF-SAS-RQ-016).
 *
 * With a projection it is the v2 form: `format: 'kf-ai-proposal-context-v2'` inside the canonical
 * preimage (packages/canonicalization/AUTHORITY.md, "Format tags"), and the projection the context
 * was drawn from beside it. Without one it is the v1 form — the same fields, untagged — which
 * exists only so proposals recorded before v2 still verify; nothing new is recorded under it.
 */
export function documentProposalContextDigest(claim: {
  readonly projection?: DocumentProposalContextProjection;
  readonly tokenizer: string;
  readonly token_budget: number;
  readonly instruction_digest: string;
  readonly included_items: readonly DocumentProposalIncludedContextProvenance[];
  readonly omitted_subject_ids: readonly string[];
}): string {
  const fields = {
    tokenizer: claim.tokenizer,
    token_budget: claim.token_budget,
    instruction_digest: claim.instruction_digest,
    included_items: claim.included_items,
    omitted_subject_ids: claim.omitted_subject_ids,
  };
  return claim.projection === undefined
    ? digest(fields)
    : digest({ ...fields, projection: claim.projection, format: DOCUMENT_PROPOSAL_CONTEXT_FORMAT });
}

/**
 * Refuse a claim recorded under a superseded context format. Verifying a stored proposal accepts
 * v1, which proposals recorded before v2 carry; recording a new one does not.
 */
export function requireCurrentDocumentProposalContextFormat(
  provenance: DocumentProposalModelProvenance,
): void {
  if (provenance.context.format !== DOCUMENT_PROPOSAL_CONTEXT_FORMAT) {
    throw new Error(
      `model provenance context must be ${DOCUMENT_PROPOSAL_CONTEXT_FORMAT}, naming the ` +
        'agent_context projection it was drawn from',
    );
  }
}

/**
 * Validate and freeze the exact model/provider/policy/context claim stored with a proposal. Accepts
 * a v1 context claim so stored proposals keep verifying; `requireCurrentDocumentProposalContextFormat`
 * is what a new proposal must also pass.
 */
export function validateDocumentProposalModelProvenance(
  value: unknown,
): DocumentProposalModelProvenance {
  const provenance = record(value, 'model proposal provenance');
  exactKeys(
    provenance,
    ['request_id', 'basis_id', 'classification', 'provider', 'policy', 'context'],
    'model proposal provenance',
  );
  const overallClassification = classification(provenance['classification']);

  const rawProvider = record(provenance['provider'], 'model provenance provider');
  exactKeys(rawProvider, ['provider_id', 'model_id', 'locality'], 'model provenance provider');
  if (rawProvider['locality'] !== 'local' && rawProvider['locality'] !== 'remote') {
    throw new Error('model provenance provider locality is not supported');
  }
  const provider = Object.freeze({
    provider_id: nonEmpty(rawProvider['provider_id'], 'model provenance provider_id'),
    model_id: nonEmpty(rawProvider['model_id'], 'model provenance model_id'),
    locality: rawProvider['locality'],
  });

  const rawPolicy = record(provenance['policy'], 'model provenance policy');
  exactKeys(rawPolicy, ['policy_id', 'decision'], 'model provenance policy');
  const decision = providerPolicyDecision(rawPolicy['decision']);
  if (provider.locality !== decision.locality) {
    throw new Error('model provenance provider locality does not match policy decision');
  }
  if (!atOrBelow(overallClassification, decision.classification_ceiling)) {
    throw new Error('model provenance classification exceeds policy decision ceiling');
  }
  const policy = Object.freeze({
    policy_id: nonEmpty(rawPolicy['policy_id'], 'model provenance policy_id'),
    decision,
  });

  const rawContext = record(provenance['context'], 'model provenance context');
  const tagged = Object.hasOwn(rawContext, 'format');
  if (tagged && rawContext['format'] !== DOCUMENT_PROPOSAL_CONTEXT_FORMAT) {
    throw new Error('model provenance context.format is not supported');
  }
  exactKeys(
    rawContext,
    [
      ...(tagged ? ['format', 'projection'] : []),
      'tokenizer',
      'token_budget',
      'instruction_digest',
      'context_digest',
      'included_items',
      'omitted_subject_ids',
    ],
    'model provenance context',
  );
  const projection = tagged ? contextProjection(rawContext['projection']) : undefined;
  if (!Array.isArray(rawContext['included_items']) || rawContext['included_items'].length === 0) {
    throw new Error('model provenance context.included_items must be a non-empty array');
  }
  if (!Array.isArray(rawContext['omitted_subject_ids'])) {
    throw new Error('model provenance context.omitted_subject_ids must be an array');
  }
  const tokenBudget = positiveOrdinal(
    rawContext['token_budget'],
    'model provenance context.token_budget',
  );
  const includedItems = Object.freeze(rawContext['included_items'].map(includedContextProvenance));
  const includedSubjects = new Set<string>();
  let tokenCount = 0;
  for (const item of includedItems) {
    if (includedSubjects.has(item.subject_id)) {
      throw new Error(`model provenance context repeats subject ${item.subject_id}`);
    }
    includedSubjects.add(item.subject_id);
    if (!atOrBelow(item.classification, overallClassification)) {
      throw new Error('model provenance context item exceeds proposal classification');
    }
    tokenCount += item.token_count;
    if (!Number.isSafeInteger(tokenCount) || tokenCount > tokenBudget) {
      throw new Error('model provenance context token count exceeds token budget');
    }
  }
  const omitted = Object.freeze(
    omittedSubjectIds(rawContext['omitted_subject_ids'], includedSubjects),
  );
  const tokenizer = nonEmpty(rawContext['tokenizer'], 'model provenance context.tokenizer');
  const instructionDigest = sha256(
    rawContext['instruction_digest'],
    'model provenance context.instruction_digest',
  );
  const contextDigest = sha256(
    rawContext['context_digest'],
    'model provenance context.context_digest',
  );
  const expectedContextDigest = documentProposalContextDigest({
    ...(projection === undefined ? {} : { projection }),
    tokenizer,
    token_budget: tokenBudget,
    instruction_digest: instructionDigest,
    included_items: includedItems,
    omitted_subject_ids: omitted,
  });
  if (contextDigest !== expectedContextDigest) {
    throw new Error('model provenance context.context_digest does not match its exact claim');
  }
  const context = Object.freeze({
    ...(projection === undefined ? {} : { format: DOCUMENT_PROPOSAL_CONTEXT_FORMAT, projection }),
    tokenizer,
    token_budget: tokenBudget,
    instruction_digest: instructionDigest,
    context_digest: contextDigest,
    included_items: includedItems,
    omitted_subject_ids: omitted,
  });

  return Object.freeze({
    request_id: nonEmpty(provenance['request_id'], 'model provenance request_id'),
    basis_id: nonEmpty(provenance['basis_id'], 'model provenance basis_id'),
    classification: overallClassification,
    provider,
    policy,
    context,
  });
}
