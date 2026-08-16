import { createPublicKey, type KeyObject } from 'node:crypto';
import { ActionRejected, type ActionEffect, type PreconditionCheck } from '@kf/actions';
import {
  SECURE_OBJECT_ACTION_TYPES,
  type RegisterAuthorityKeyInput,
  SecureObjectRejected,
  type SecureObjectActionAtoms,
  type SecureObjectActionType,
  type SecureObjectAuthoritySigner,
} from './contracts.js';
import { authoritySigningKeyMaterial } from './action-intents.js';
import {
  consumeReadCapability,
  issueReadCapability,
  revokeReadCapability,
} from './capabilities.js';
import {
  loadAuthoritySigningKey,
  registerAuthoritySigningKey,
  revokeAuthoritySigningKey,
} from './keys.js';
import { requestReadCapability } from './read-requests.js';
import { requestErasure } from './erasure-requests.js';
import { signErasureTombstone } from './tombstones.js';
import {
  loadErasureRequest,
  loadReadCapability,
  loadReadRequest,
  payloadInteger,
  payloadKeyRevocationReason,
  payloadNullableString,
  payloadPurpose,
  payloadString,
  requireOrganizationTarget,
  requireSecureObjectRoleCategory,
} from './dispatcher-support.js';
import {
  authoritySignerTimeout,
  contentSha256,
  externalAuthorityRef,
  externalRevisionRef,
  policyDecisionRef,
  workloadIdentityRef,
} from './validation.js';

/**
 * Compose secure-object mutations into the core dispatcher transaction. Standalone helpers
 * remain useful to effects and tests, but a production caller submits these action atoms so
 * the action, exact receipt, audit event, and outbox either all commit or all roll back.
 */
export function createSecureObjectActionAtoms(
  options: {
    readonly authoritySigner?: SecureObjectAuthoritySigner;
    readonly authoritySignerTimeoutMs?: number;
  } = {},
): SecureObjectActionAtoms {
  const signerTimeoutMs = authoritySignerTimeout(options.authoritySignerTimeoutMs);
  const precondition: PreconditionCheck = async (tx, request, objects) => {
    requireOrganizationTarget(request, objects);
    await requireSecureObjectRoleCategory(tx, request);
  };

  const requestRead: ActionEffect = async (tx, request) => {
    if (payloadString(request, 'idempotencyKey') !== request.idempotencyKey) {
      throw new ActionRejected(
        'precondition_failed',
        'payload.idempotencyKey must equal the dispatcher idempotency key',
      );
    }
    await requestReadCapability(tx, {
      organizationId: request.organizationId,
      classificationId: payloadString(request, 'classificationId'),
      authorityRef: externalAuthorityRef(payloadString(request, 'authorityRef')),
      revisionRef: externalRevisionRef(payloadString(request, 'revisionRef')),
      externalContentSha256: contentSha256(payloadString(request, 'externalContentSha256')),
      purpose: payloadPurpose(request),
      workloadIdentityRef: workloadIdentityRef(payloadString(request, 'workloadIdentityRef')),
      policyDecisionRef: policyDecisionRef(payloadString(request, 'policyDecisionRef')),
      idempotencyKey: request.idempotencyKey,
      ttlSeconds: payloadInteger(request, 'ttlSeconds'),
    });
  };

  const issueRead: ActionEffect = async (tx, request) => {
    const requested = await loadReadRequest(tx, payloadString(request, 'requestId'));
    await issueReadCapability(tx, { request: requested });
  };

  const revokeRead: ActionEffect = async (tx, request) => {
    const capability = await loadReadCapability(tx, payloadString(request, 'capabilityId'));
    if (!(await revokeReadCapability(tx, { capability }))) {
      throw new SecureObjectRejected(
        'capability_unavailable',
        'read capability cannot be revoked in its current terminal state',
      );
    }
  };

  const consumeRead: ActionEffect = async (tx, request) => {
    const capability = await loadReadCapability(tx, payloadString(request, 'capabilityId'));
    await consumeReadCapability(tx, { capability });
  };

  const requestErasureEffect: ActionEffect = async (tx, request) => {
    if (payloadPurpose(request) !== 'authorized_erasure') {
      throw new ActionRejected(
        'precondition_failed',
        'secure-object erasure requires authorized_erasure purpose',
      );
    }
    await requestErasure(tx, {
      organizationId: request.organizationId,
      classificationId: payloadString(request, 'classificationId'),
      authorityRef: externalAuthorityRef(payloadString(request, 'authorityRef')),
      revisionRef: externalRevisionRef(payloadString(request, 'revisionRef')),
      externalContentSha256: contentSha256(payloadString(request, 'externalContentSha256')),
      purpose: 'authorized_erasure',
      workloadIdentityRef: workloadIdentityRef(payloadString(request, 'workloadIdentityRef')),
      policyDecisionRef: policyDecisionRef(payloadString(request, 'policyDecisionRef')),
    });
  };

  const registerKey: ActionEffect = async (tx, request) => {
    const publicKeySpkiDerBase64 = payloadString(request, 'publicKeySpkiDerBase64');
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({
        key: Buffer.from(publicKeySpkiDerBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });
    } catch {
      throw new SecureObjectRejected('invalid_key', 'registered public key is not valid SPKI DER');
    }
    const input: RegisterAuthorityKeyInput = {
      organizationId: request.organizationId,
      authorityRef: externalAuthorityRef(payloadString(request, 'authorityRef')),
      keyId: payloadString(request, 'keyId'),
      publicKey,
      rotatesKeyRegistryId: payloadNullableString(request, 'rotatesKeyRegistryId'),
      validUntil:
        payloadNullableString(request, 'validUntil') === null
          ? null
          : new Date(payloadString(request, 'validUntil')),
    };
    const material = authoritySigningKeyMaterial(publicKey);
    if (
      material.publicKeySpkiDerBase64 !== publicKeySpkiDerBase64 ||
      material.publicKeySha256 !== payloadString(request, 'publicKeySha256')
    ) {
      throw new SecureObjectRejected(
        'invalid_key',
        'registered public key bytes do not match the action digest',
      );
    }
    await registerAuthoritySigningKey(tx, input);
  };

  const revokeKey: ActionEffect = async (tx, request) => {
    const key = await loadAuthoritySigningKey(tx, payloadString(request, 'signingKeyRegistryId'));
    if (
      !(await revokeAuthoritySigningKey(tx, {
        key,
        reasonCode: payloadKeyRevocationReason(request),
      }))
    ) {
      throw new SecureObjectRejected('signing_key_unavailable', 'signing key is already revoked');
    }
  };

  const recordErasure: ActionEffect = async (tx, request) => {
    if (options.authoritySigner === undefined) {
      throw new SecureObjectRejected(
        'signing_key_unavailable',
        'no external Secure Object Authority signer is configured',
      );
    }
    const erasure = await loadErasureRequest(tx, payloadString(request, 'requestId'));
    const signingKeyRegistryId = payloadString(request, 'signingKeyRegistryId');
    await signErasureTombstone(tx, {
      request: erasure,
      signingKeyRegistryId,
      signerTimeoutMs,
      signer: (canonicalTombstoneBytes, signal) =>
        options.authoritySigner!.sign({
          organizationId: erasure.organizationId,
          authorityRef: erasure.authorityRef,
          signingKeyRegistryId,
          canonicalTombstoneBytes,
          signal,
        }),
    });
  };

  const effects: Record<SecureObjectActionType, ActionEffect> = {
    [SECURE_OBJECT_ACTION_TYPES.requestRead]: requestRead,
    [SECURE_OBJECT_ACTION_TYPES.issueRead]: issueRead,
    [SECURE_OBJECT_ACTION_TYPES.revokeRead]: revokeRead,
    [SECURE_OBJECT_ACTION_TYPES.consumeRead]: consumeRead,
    [SECURE_OBJECT_ACTION_TYPES.requestErasure]: requestErasureEffect,
    [SECURE_OBJECT_ACTION_TYPES.recordErasure]: recordErasure,
    [SECURE_OBJECT_ACTION_TYPES.registerAuthorityKey]: registerKey,
    [SECURE_OBJECT_ACTION_TYPES.revokeAuthorityKey]: revokeKey,
  };
  const preconditions = Object.fromEntries(
    Object.values(SECURE_OBJECT_ACTION_TYPES).map((actionType) => [actionType, precondition]),
  ) as Record<SecureObjectActionType, PreconditionCheck>;

  return {
    name: 'secure-object',
    ownedActions: Object.values(SECURE_OBJECT_ACTION_TYPES),
    effects,
    preconditions,
  };
}
