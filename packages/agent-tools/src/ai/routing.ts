import type {
  AiProposalRequest,
  AiProvider,
  AiProviderPolicyDecision,
  RemoteProviderPolicy,
} from './types.js';
import {
  atOrBelow,
  exactKeys,
  record,
  requireClassification,
  requireNonempty,
} from './primitives.js';

function remotePolicy(value: unknown): RemoteProviderPolicy {
  const policy = record(value, 'remote provider policy');
  exactKeys(
    policy,
    [
      'providerId',
      'modelId',
      'classificationCeiling',
      'retentionDays',
      'trainingUse',
      'transportPolicy',
    ],
    'remote provider policy',
  );
  if (!Number.isSafeInteger(policy['retentionDays']) || (policy['retentionDays'] as number) < 0) {
    throw new Error('remote provider policy has invalid retention');
  }
  if (policy['trainingUse'] !== 'disabled' && policy['trainingUse'] !== 'contractually_disabled') {
    throw new Error('remote provider policy must disable training use');
  }
  if (policy['transportPolicy'] !== 'tls_1_3' && policy['transportPolicy'] !== 'private_endpoint') {
    throw new Error('remote provider policy has invalid transport policy');
  }
  return Object.freeze({
    providerId: requireNonempty(policy['providerId'], 'remote providerId'),
    modelId: requireNonempty(policy['modelId'], 'remote modelId'),
    classificationCeiling: requireClassification(
      policy['classificationCeiling'],
      'remote classification ceiling',
    ),
    retentionDays: policy['retentionDays'] as number,
    trainingUse: policy['trainingUse'],
    transportPolicy: policy['transportPolicy'],
  });
}

export function authorizeProvider(
  provider: AiProvider,
  request: AiProposalRequest,
  value: unknown,
): { readonly policyId: string; readonly decision: AiProviderPolicyDecision } {
  const policy = record(value, 'AI routing policy');
  exactKeys(
    policy,
    ['policyId', 'localClassificationCeiling', 'remoteAllowlist'],
    'AI routing policy',
  );
  const policyId = requireNonempty(policy['policyId'], 'policyId');
  const localCeiling = requireClassification(
    policy['localClassificationCeiling'],
    'local classification ceiling',
  );
  if (!Array.isArray(policy['remoteAllowlist'])) {
    throw new Error('remoteAllowlist must be an array');
  }
  requireNonempty(provider.providerId, 'providerId');
  requireNonempty(provider.modelId, 'modelId');
  if (provider.locality !== 'local' && provider.locality !== 'remote') {
    throw new Error('provider locality is not supported');
  }
  if (provider.locality === 'local') {
    if (!atOrBelow(request.classification, localCeiling)) {
      throw new Error('request exceeds local provider classification ceiling');
    }
    return Object.freeze({
      policyId,
      decision: Object.freeze({ locality: 'local', classification_ceiling: localCeiling }),
    });
  }
  const matches = policy['remoteAllowlist']
    .map(remotePolicy)
    .filter(
      (entry) => entry.providerId === provider.providerId && entry.modelId === provider.modelId,
    );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `remote provider ${provider.providerId}/${provider.modelId} is not allowlisted`
        : `remote provider ${provider.providerId}/${provider.modelId} has ambiguous allowlist entries`,
    );
  }
  const allowed = matches[0]!;
  if (!atOrBelow(request.classification, allowed.classificationCeiling)) {
    throw new Error('request exceeds remote provider classification ceiling');
  }
  return Object.freeze({
    policyId,
    decision: Object.freeze({
      locality: 'remote',
      classification_ceiling: allowed.classificationCeiling,
      retention_days: allowed.retentionDays,
      training_use: allowed.trainingUse,
      transport_policy: allowed.transportPolicy,
    }),
  });
}
