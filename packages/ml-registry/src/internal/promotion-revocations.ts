import { sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalBytes, digest } from '@kf/canonicalization';
import type {
  PrivateSigningKey,
  PromotionRevocationInput,
  PromotionVerification,
  PromotionVerificationFinding,
  SignedPromotionRevocation,
} from './contracts.js';
import { isPromotionRevocationReason } from '../public-contracts.js';
import {
  GOVERNANCE_ID,
  assertExactKeys,
  checkedEd25519Signature,
  checkedId,
  checkedOrganizationId,
  checkedSha256,
  checkedTimestamp,
  reject,
} from './validation.js';

const REVOCATION_INPUT_KEYS = [
  'organizationId',
  'aliasId',
  'receiptDigest',
  'reasonCode',
  'revokedAt',
] as const;
/** Issue a signed, append-only revocation for one exact promotion receipt. */
export function signPromotionRevocation(
  input: PromotionRevocationInput,
  key: PrivateSigningKey,
): SignedPromotionRevocation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    reject('promotion revocation input must be an object');
  }
  assertExactKeys(input, REVOCATION_INPUT_KEYS, 'promotion revocation input');
  if (!isPromotionRevocationReason(input.reasonCode)) {
    reject('promotion revocation needs a safe reason code');
  }
  const unsigned = Object.freeze({
    schemaVersion: 'kf.ml.promotion-revocation.v1' as const,
    issuer: 'knowledge-fabric' as const,
    organizationId: checkedOrganizationId(
      input.organizationId,
      'promotion revocation.organizationId',
    ),
    aliasId: checkedId(input.aliasId, 'promotion revocation.aliasId', GOVERNANCE_ID),
    receiptDigest: checkedSha256(input.receiptDigest, 'promotion revocation.receiptDigest'),
    reasonCode: input.reasonCode,
    revokedAt: checkedTimestamp(input.revokedAt, 'promotion revocation.revokedAt'),
    signingKeyId: checkedId(key.id, 'promotion revocation.signingKeyId'),
  });
  return Object.freeze({
    ...unsigned,
    revocationDigest: digest(unsigned),
    signature: edSign(null, canonicalBytes(unsigned), key.privateKey).toString('base64'),
  });
}

const PROMOTION_REVOCATION_KEYS = [
  ...REVOCATION_INPUT_KEYS,
  'schemaVersion',
  'issuer',
  'signingKeyId',
  'revocationDigest',
  'signature',
] as const;

function normalizedRevocationUnsigned(revocation: SignedPromotionRevocation) {
  assertExactKeys(revocation, PROMOTION_REVOCATION_KEYS, 'promotion revocation');
  if (
    revocation.schemaVersion !== 'kf.ml.promotion-revocation.v1' ||
    revocation.issuer !== 'knowledge-fabric' ||
    !isPromotionRevocationReason(revocation.reasonCode)
  ) {
    reject('unsupported promotion revocation authority, version, or reason');
  }
  return {
    schemaVersion: revocation.schemaVersion,
    issuer: revocation.issuer,
    organizationId: checkedOrganizationId(
      revocation.organizationId,
      'promotion revocation.organizationId',
    ),
    aliasId: checkedId(revocation.aliasId, 'promotion revocation.aliasId', GOVERNANCE_ID),
    receiptDigest: checkedSha256(revocation.receiptDigest, 'promotion revocation.receiptDigest'),
    reasonCode: revocation.reasonCode,
    revokedAt: checkedTimestamp(revocation.revokedAt, 'promotion revocation.revokedAt'),
    signingKeyId: checkedId(revocation.signingKeyId, 'promotion revocation.signingKeyId'),
  };
}

export function verifyPromotionRevocation(
  revocation: SignedPromotionRevocation,
  publicKeys: ReadonlyMap<string, KeyObject>,
): PromotionVerification {
  const findings: PromotionVerificationFinding[] = [];
  try {
    if (revocation === null || typeof revocation !== 'object' || Array.isArray(revocation)) {
      return { valid: false, findings: ['malformed_record'] };
    }
    const unsigned = normalizedRevocationUnsigned(revocation);
    if (
      typeof revocation.revocationDigest !== 'string' ||
      digest(unsigned) !== revocation.revocationDigest
    ) {
      findings.push('digest_mismatch');
    }
    const signature = checkedEd25519Signature(
      revocation.signature,
      'promotion revocation.signature',
    );
    const key = publicKeys.get(unsigned.signingKeyId);
    if (key === undefined) {
      findings.push('unknown_signing_key');
    } else if (!edVerify(null, canonicalBytes(unsigned), key, signature)) {
      findings.push('bad_signature');
    }
  } catch {
    findings.push('malformed_record');
  }
  return Object.freeze({ valid: findings.length === 0, findings: Object.freeze(findings) });
}
