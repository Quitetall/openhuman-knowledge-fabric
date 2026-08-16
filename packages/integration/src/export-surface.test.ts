import { describe, expect, it } from 'vitest';
import * as integration from './index.js';
import * as secureObject from './secure-object.js';
import type {
  MetricEventAppendInput,
  MetricStreamAuthorizationInput,
  MlActionAtoms,
  MlActionIntent,
  MlActionType,
  MlPromotionActionIntent,
  MlPromotionAuthorityKind,
  MlPromotionRiskTier,
  PromotionAuthorizationInput,
  SecureObjectActionAtoms,
  SecureObjectActionIntent,
  SecureObjectActionType,
  SecureObjectAuthoritySigner,
} from './index.js';

const rawSecureObjectWriters = [
  'requestReadCapability',
  'issueReadCapability',
  'revokeReadCapability',
  'consumeReadCapability',
  'requestErasure',
  'registerAuthoritySigningKey',
  'revokeAuthoritySigningKey',
  'loadAuthoritySigningKey',
  'signErasureTombstone',
  'tombstoneBytes',
] as const;

const dispatcherSurface = [
  'ML_ACTION_TYPES',
  'actionForMetricEventAppend',
  'actionForMetricStreamAuthorization',
  'actionForPromotionAuthorization',
  'createMlActionAtoms',
  'metricEventActionIdempotencyKey',
  'SECURE_OBJECT_ACTION_TYPES',
  'actionForAuthoritySigningKeyRegistration',
  'actionForAuthoritySigningKeyRevocation',
  'actionForErasureRequest',
  'actionForErasureTombstone',
  'actionForReadCapabilityConsumption',
  'actionForReadCapabilityIssue',
  'actionForReadCapabilityRequest',
  'actionForReadCapabilityRevocation',
  'createSecureObjectActionAtoms',
  'verifyErasureTombstone',
] as const;

type IntegrationTypeSurface = [
  MetricEventAppendInput,
  MetricStreamAuthorizationInput,
  MlActionAtoms,
  MlActionIntent,
  MlActionType,
  MlPromotionActionIntent,
  MlPromotionAuthorityKind,
  MlPromotionRiskTier,
  PromotionAuthorizationInput,
  SecureObjectActionAtoms,
  SecureObjectActionIntent,
  SecureObjectActionType,
  SecureObjectAuthoritySigner,
];

describe('integration export surface', () => {
  it('keeps raw secure-object Tx writers package-internal', () => {
    for (const symbol of rawSecureObjectWriters) {
      expect(integration).not.toHaveProperty(symbol);
      expect(secureObject).not.toHaveProperty(symbol);
    }
  });

  it('keeps dispatcher-governed action builders, action atoms, and public types available', () => {
    for (const symbol of dispatcherSurface) {
      expect(integration).toHaveProperty(symbol);
    }

    const _typesOnly: IntegrationTypeSurface | undefined = undefined;
    expect(_typesOnly).toBeUndefined();
  });
});
