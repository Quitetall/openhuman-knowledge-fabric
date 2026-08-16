import { digest } from '@kf/canonicalization';

import type {
  DocumentProposalContextKind,
  DocumentProposalIncludedContextProvenance,
  DocumentProposalModelProvenance,
  DocumentProposalProviderPolicyDecision,
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

/** Validate and freeze the exact model/provider/policy/context claim stored with a proposal. */
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
  exactKeys(
    rawContext,
    [
      'tokenizer',
      'token_budget',
      'instruction_digest',
      'context_digest',
      'included_items',
      'omitted_subject_ids',
    ],
    'model provenance context',
  );
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
  const expectedContextDigest = digest({
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
