import type { KeyObject } from 'node:crypto';
import { digestBytes } from '@kf/canonicalization';
import {
  SECURE_OBJECT_ACTION_TYPES,
  type ActionParameter,
  type AuthorityKeyRevocationReason,
  type AuthoritySigningKey,
  type ContentSha256,
  type ExternalAuthorityRef,
  type ExternalRevisionRef,
  type ErasureRequest,
  type ReadCapability,
  type ReadCapabilityRequest,
  type RegisterAuthorityKeyInput,
  SecureObjectRejected,
  type ScopedPolicyBinding,
  type SecureObjectActionIntent,
  type SecureObjectActionType,
} from './contracts.js';
import { contentSha256, opaqueReference } from './validation.js';

export function action(
  actionType: SecureObjectActionType,
  targetId: string,
  parameters: Readonly<Record<string, ActionParameter>>,
): SecureObjectActionIntent {
  return { actionType, targetId, parameters };
}

export function actionForReadCapabilityRequest(
  request: ScopedPolicyBinding & {
    readonly authorityRef: ExternalAuthorityRef;
    readonly revisionRef: ExternalRevisionRef;
    readonly externalContentSha256: ContentSha256;
    readonly idempotencyKey: string;
    readonly ttlSeconds: number;
  },
): SecureObjectActionIntent {
  return action(SECURE_OBJECT_ACTION_TYPES.requestRead, request.organizationId, {
    organizationId: request.organizationId,
    classificationId: request.classificationId,
    authorityRef: request.authorityRef,
    revisionRef: request.revisionRef,
    externalContentSha256: request.externalContentSha256,
    purpose: request.purpose,
    workloadIdentityRef: request.workloadIdentityRef,
    policyDecisionRef: request.policyDecisionRef,
    idempotencyKey: request.idempotencyKey,
    ttlSeconds: request.ttlSeconds,
  });
}

export function actionForReadCapabilityIssue(
  request: ReadCapabilityRequest,
): SecureObjectActionIntent {
  return action(SECURE_OBJECT_ACTION_TYPES.issueRead, request.organizationId, {
    requestId: request.id,
    authorityRef: request.authorityRef,
    revisionRef: request.revisionRef,
    externalContentSha256: request.externalContentSha256,
    purpose: request.purpose,
    workloadIdentityRef: request.workloadIdentityRef,
    policyDecisionRef: request.policyDecisionRef,
  });
}

function actionForCapability(
  actionType:
    typeof SECURE_OBJECT_ACTION_TYPES.revokeRead | typeof SECURE_OBJECT_ACTION_TYPES.consumeRead,
  capability: ReadCapability,
): SecureObjectActionIntent {
  return action(actionType, capability.organizationId, {
    capabilityId: capability.id,
    authorityRef: capability.authorityRef,
    revisionRef: capability.revisionRef,
    externalContentSha256: capability.externalContentSha256,
    purpose: capability.purpose,
    workloadIdentityRef: capability.workloadIdentityRef,
    policyDecisionRef: capability.policyDecisionRef,
  });
}

export function actionForReadCapabilityRevocation(
  capability: ReadCapability,
): SecureObjectActionIntent {
  return actionForCapability(SECURE_OBJECT_ACTION_TYPES.revokeRead, capability);
}

export function actionForReadCapabilityConsumption(
  capability: ReadCapability,
): SecureObjectActionIntent {
  return actionForCapability(SECURE_OBJECT_ACTION_TYPES.consumeRead, capability);
}

export function actionForErasureRequest(
  request: ScopedPolicyBinding & {
    readonly purpose: 'authorized_erasure';
    readonly authorityRef: ExternalAuthorityRef;
    readonly revisionRef: ExternalRevisionRef;
    readonly externalContentSha256: ContentSha256;
  },
): SecureObjectActionIntent {
  return action(SECURE_OBJECT_ACTION_TYPES.requestErasure, request.organizationId, {
    organizationId: request.organizationId,
    classificationId: request.classificationId,
    authorityRef: request.authorityRef,
    revisionRef: request.revisionRef,
    externalContentSha256: request.externalContentSha256,
    purpose: request.purpose,
    workloadIdentityRef: request.workloadIdentityRef,
    policyDecisionRef: request.policyDecisionRef,
  });
}

export function actionForErasureTombstone(
  request: ErasureRequest,
  signingKeyRegistryId: string,
): SecureObjectActionIntent {
  return action(SECURE_OBJECT_ACTION_TYPES.recordErasure, request.organizationId, {
    requestId: request.id,
    authorityRef: request.authorityRef,
    revisionRef: request.revisionRef,
    externalContentSha256: request.externalContentSha256,
    purpose: request.purpose,
    workloadIdentityRef: request.workloadIdentityRef,
    policyDecisionRef: request.policyDecisionRef,
    signingKeyRegistryId,
  });
}

export function authoritySigningKeyMaterial(publicKey: KeyObject): {
  readonly publicKeySpkiDerBase64: string;
  readonly publicKeySha256: ContentSha256;
} {
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new SecureObjectRejected('invalid_key', 'authority signing key must be public Ed25519');
  }
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKeySpkiDerBase64: spki.toString('base64'),
    publicKeySha256: contentSha256(digestBytes(spki)),
  };
}

export function actionForAuthoritySigningKeyRegistration(
  input: RegisterAuthorityKeyInput,
): SecureObjectActionIntent {
  opaqueReference(input.keyId, 'signing key identifier', 255);
  const material = authoritySigningKeyMaterial(input.publicKey);
  return action(SECURE_OBJECT_ACTION_TYPES.registerAuthorityKey, input.organizationId, {
    organizationId: input.organizationId,
    authorityRef: input.authorityRef,
    keyId: input.keyId,
    publicKeySpkiDerBase64: material.publicKeySpkiDerBase64,
    publicKeySha256: material.publicKeySha256,
    rotatesKeyRegistryId: input.rotatesKeyRegistryId,
    validUntil: input.validUntil?.toISOString() ?? null,
  });
}

export function actionForAuthoritySigningKeyRevocation(
  key: AuthoritySigningKey,
  reasonCode: AuthorityKeyRevocationReason,
): SecureObjectActionIntent {
  return action(SECURE_OBJECT_ACTION_TYPES.revokeAuthorityKey, key.organizationId, {
    signingKeyRegistryId: key.id,
    reasonCode,
  });
}
