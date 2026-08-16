import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import type { Tx } from '@kf/database';
import {
  decodeIsoTimestamp,
  decodeNullableString,
  decodeSha256,
  decodeString,
  ProjectionError,
} from './projection.js';
import { canonicalBase64 } from './validation.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

interface PromotionVerificationKeyRow {
  readonly [column: string]: unknown;
  readonly organization_id: unknown;
  readonly key_registry_id: unknown;
  readonly key_id: unknown;
  readonly algorithm: unknown;
  readonly public_key_spki_der_base64: unknown;
  readonly public_key_sha256: unknown;
  readonly rotates_key_registry_id: unknown;
  readonly valid_from: unknown;
  readonly valid_until: unknown;
  readonly registered_at: unknown;
  readonly revocation_reason_code: unknown;
  readonly revoked_at: unknown;
}

export interface TrustedPromotionKey {
  readonly publicKey: KeyObject;
  readonly projection: {
    readonly keyRegistryId: string;
    readonly keyId: string;
    readonly algorithm: 'Ed25519';
    readonly publicKeySpkiDerBase64: string;
    readonly publicKeyDigest: string;
    readonly rotatesKeyRegistryId: string | null;
    readonly validFrom: string;
    readonly validUntil: string | null;
    readonly registeredAt: string;
    readonly trustState: 'trusted_for_receipt';
    readonly revocation: null;
  };
}

export async function readTrustedPromotionKey(
  tx: Tx,
  organizationId: string,
  signingKeyId: string,
  promotedAt: string,
): Promise<TrustedPromotionKey | undefined> {
  const row = await tx.maybeOne<PromotionVerificationKeyRow>(
    `/* ml.governed-alias-key */
     select organization_id::text as organization_id,
            key_registry_id::text as key_registry_id,
            key_id,
            algorithm,
            public_key_spki_der_base64,
            public_key_sha256,
            rotates_key_registry_id::text as rotates_key_registry_id,
            valid_from,
            valid_until,
            registered_at,
            revocation_reason_code,
            revoked_at
       from ml.promotion_verification_key
      where organization_id = $1::uuid
        and key_id = $2
        and valid_from <= $3::timestamptz
        and (valid_until is null or $3::timestamptz < valid_until)`,
    [organizationId, signingKeyId, promotedAt],
  );
  if (row === undefined) return undefined;

  const publicKeySpki = decodeString(
    row.public_key_spki_der_base64,
    'promotionKey.publicKeySpkiDerBase64',
  );
  const publicKeyDigest = decodeSha256(row.public_key_sha256, 'promotionKey.publicKeyDigest');
  const publicKeyBytes = canonicalBase64(publicKeySpki, 44);
  const validFrom = decodeIsoTimestamp(row.valid_from, 'promotionKey.validFrom');
  const validUntil =
    row.valid_until === null
      ? null
      : decodeIsoTimestamp(row.valid_until, 'promotionKey.validUntil');
  if (
    decodeString(row.organization_id, 'promotionKey.organizationId') !== organizationId ||
    decodeString(row.key_id, 'promotionKey.keyId') !== signingKeyId ||
    decodeString(row.algorithm, 'promotionKey.algorithm') !== 'Ed25519' ||
    publicKeyBytes === undefined ||
    !publicKeyBytes.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX) ||
    createHash('sha256').update(publicKeyBytes).digest('hex') !== publicKeyDigest ||
    row.revoked_at !== null ||
    decodeNullableString(row.revocation_reason_code, 'promotionKey.revocationReasonCode') !==
      null ||
    promotedAt < validFrom ||
    (validUntil !== null && promotedAt >= validUntil)
  ) {
    throw new ProjectionError('ML promotion verification key is invalid');
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
  } catch {
    throw new ProjectionError('ML promotion verification key is invalid');
  }

  return {
    publicKey,
    projection: {
      keyRegistryId: decodeString(row.key_registry_id, 'promotionKey.keyRegistryId'),
      keyId: signingKeyId,
      algorithm: 'Ed25519',
      publicKeySpkiDerBase64: publicKeySpki,
      publicKeyDigest,
      rotatesKeyRegistryId: decodeNullableString(
        row.rotates_key_registry_id,
        'promotionKey.rotatesKeyRegistryId',
      ),
      validFrom,
      validUntil,
      registeredAt: decodeIsoTimestamp(row.registered_at, 'promotionKey.registeredAt'),
      trustState: 'trusted_for_receipt',
      revocation: null,
    },
  };
}
