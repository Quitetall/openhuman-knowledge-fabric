import { createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalBytes } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import { actionForErasureTombstone } from './action-intents.js';
import { type ErasureRequest, type ErasureTombstone, SecureObjectRejected } from './contracts.js';
import {
  authoritySignerTimeout,
  canonicalBase64Bytes,
  contentSha256,
  policyDecisionRef,
  signWithDeadline,
  workloadIdentityRef,
} from './validation.js';

const TOMBSTONE_VERSION = 'kf-secure-object-erasure-tombstone/v1' as const;

export function tombstoneBytes(
  tombstone: Pick<
    ErasureTombstone,
    | 'version'
    | 'erasureRequestId'
    | 'externalContentSha256'
    | 'purpose'
    | 'workloadIdentityRef'
    | 'policyDecisionRef'
    | 'erasedAt'
    | 'signerId'
    | 'signerActionId'
    | 'signingKeyRegistryId'
    | 'signingKeyId'
  >,
): Buffer {
  return canonicalBytes({
    erased_at: tombstone.erasedAt.toISOString(),
    erasure_request_id: tombstone.erasureRequestId,
    external_content_sha256: tombstone.externalContentSha256,
    policy_decision_ref: tombstone.policyDecisionRef,
    purpose: tombstone.purpose,
    signer_action_id: tombstone.signerActionId,
    signer_id: tombstone.signerId,
    signing_key_id: tombstone.signingKeyId,
    signing_key_registry_id: tombstone.signingKeyRegistryId,
    version: tombstone.version,
    workload_identity_ref: tombstone.workloadIdentityRef,
  });
}

/**
 * Record the current KF actor's assertion that exact authorized erasure was fulfilled.
 * The external signer receives canonical bytes; KF verifies against the active registered
 * public key before writing and never receives a private key or object locator.
 */
export async function signErasureTombstone(
  tx: Tx,
  input: {
    readonly request: ErasureRequest;
    readonly signingKeyRegistryId: string;
    readonly signer: (bytes: Uint8Array, signal: AbortSignal) => Uint8Array | Promise<Uint8Array>;
    readonly signerTimeoutMs?: number;
  },
): Promise<ErasureTombstone> {
  const { request } = input;
  const intent = actionForErasureTombstone(request, input.signingKeyRegistryId);
  // Validate before invoking an external signer. The insert trigger repeats this check, but
  // doing it only after signing would turn a wrong/replayed action into a signing oracle.
  await tx.query(`select secure_object.require_exact_action($1, $2, $3::jsonb) as action_id`, [
    intent.actionType,
    intent.targetId,
    JSON.stringify(intent.parameters),
  ]);
  const available = await tx.maybeOne<{
    readonly [key: string]: unknown;
    readonly erasure_request_id: string;
    readonly external_content_sha256: string;
    readonly purpose: 'authorized_erasure';
    readonly workload_identity_ref: string;
    readonly policy_decision_ref: string;
    readonly erased_at: Date;
    readonly signer_id: string;
    readonly signer_action_id: string;
    readonly signing_key_registry_id: string;
    readonly signing_key_id: string;
    readonly public_key_spki_der_base64: string;
  }>(
    `select r.id as erasure_request_id, r.external_content_sha256, r.purpose,
            r.workload_identity_ref, r.policy_decision_ref, a.effective_at as erased_at,
            a.actor_id as signer_id, a.id as signer_action_id,
            k.id as signing_key_registry_id, k.key_id as signing_key_id,
            k.public_key_spki_der_base64
       from secure_object.erasure_request r
       join core.action a on a.id = core.current_action_id()
       join secure_object.authority_signing_key k on k.id = $2
      where r.id = $1
        and r.organization_id = $3
        and r.classification_id = $4
        and r.external_authority_ref = $5
        and r.external_revision_ref = $6
        and r.external_content_sha256 = $7
        and r.purpose = $8
        and r.workload_identity_ref = $9
        and r.policy_decision_ref = $10
        and k.organization_id = r.organization_id
        and k.external_authority_ref = r.external_authority_ref
        and k.valid_from <= a.effective_at
        and (k.valid_until is null or k.valid_until > a.effective_at)
        and not exists (
          select 1 from secure_object.authority_signing_key_revocation v
           where v.signing_key_registry_id = k.id
        )
        and not exists (
          select 1 from secure_object.erasure_tombstone t where t.erasure_request_id = r.id
        )`,
    [
      request.id,
      input.signingKeyRegistryId,
      request.organizationId,
      request.classificationId,
      request.authorityRef,
      request.revisionRef,
      request.externalContentSha256,
      request.purpose,
      request.workloadIdentityRef,
      request.policyDecisionRef,
    ],
  );
  if (available === undefined) {
    throw new SecureObjectRejected(
      'signing_key_unavailable',
      'erasure request or active registered authority signing key is unavailable',
    );
  }

  const unsigned = {
    version: TOMBSTONE_VERSION,
    erasureRequestId: available.erasure_request_id,
    externalContentSha256: contentSha256(available.external_content_sha256),
    purpose: available.purpose,
    workloadIdentityRef: workloadIdentityRef(available.workload_identity_ref),
    policyDecisionRef: policyDecisionRef(available.policy_decision_ref),
    erasedAt: available.erased_at,
    signerId: available.signer_id,
    signerActionId: available.signer_action_id,
    signingKeyRegistryId: available.signing_key_registry_id,
    signingKeyId: available.signing_key_id,
  };
  const bytes = tombstoneBytes(unsigned);
  const signatureBytes = Buffer.from(
    await signWithDeadline(input.signer, bytes, authoritySignerTimeout(input.signerTimeoutMs)),
  );
  const publicKeyBytes = canonicalBase64Bytes(available.public_key_spki_der_base64, 44);
  if (publicKeyBytes === undefined) {
    throw new SecureObjectRejected(
      'signing_key_unavailable',
      'registered authority key is not canonical Ed25519 SPKI base64',
    );
  }
  const publicKey = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
  if (signatureBytes.length !== 64 || !edVerify(null, bytes, publicKey, signatureBytes)) {
    throw new SecureObjectRejected(
      'signing_key_unavailable',
      'external signer did not prove possession of the active registered authority key',
    );
  }
  const signature = signatureBytes.toString('base64');

  const stored = await tx.maybeOne<{ readonly id: string }>(
    `insert into secure_object.erasure_tombstone
       (erasure_request_id, external_content_sha256, purpose, workload_identity_ref,
        policy_decision_ref, tombstone_version, erased_at, signing_key_registry_id,
        signing_key_id, signature)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (erasure_request_id) do nothing
     returning id`,
    [
      unsigned.erasureRequestId,
      unsigned.externalContentSha256,
      unsigned.purpose,
      unsigned.workloadIdentityRef,
      unsigned.policyDecisionRef,
      unsigned.version,
      unsigned.erasedAt,
      unsigned.signingKeyRegistryId,
      unsigned.signingKeyId,
      signature,
    ],
  );
  if (stored === undefined) {
    throw new SecureObjectRejected(
      'erasure_unavailable',
      'erasure request already has a tombstone',
    );
  }

  return { id: stored.id, ...unsigned, signature };
}

/** Verify RFC 8785 canonical tombstone bytes under separately selected public key. */
export function verifyErasureTombstone(tombstone: ErasureTombstone, publicKey: KeyObject): boolean {
  try {
    const signature = canonicalBase64Bytes(tombstone.signature, 64);
    return (
      signature !== undefined &&
      publicKey.type === 'public' &&
      publicKey.asymmetricKeyType === 'ed25519' &&
      edVerify(null, tombstoneBytes(tombstone), publicKey, signature)
    );
  } catch {
    return false;
  }
}
