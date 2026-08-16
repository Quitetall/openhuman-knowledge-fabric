import { sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalBytes, compareCanonicalText, digest } from '@kf/canonicalization';
import type {
  AggregateReference,
  PrivateSigningKey,
  PromotionReceiptInput,
  PromotionVerification,
  PromotionVerificationFinding,
  SignedPromotionReceipt,
} from './contracts.js';
import { isPromotionRiskTier } from '../public-contracts.js';
import {
  GOVERNANCE_ID,
  assertExactKeys,
  checkedAggregate,
  checkedAggregates,
  checkedEd25519Signature,
  checkedId,
  checkedOrganizationId,
  checkedSha256,
  checkedTimestamp,
  reject,
  requireOneOrganization,
} from './validation.js';

const PROMOTION_INPUT_KEYS = [
  'organizationId',
  'aliasId',
  'candidate',
  'runSealDigest',
  'policy',
  'evidence',
  'riskTier',
  'technicalAuthorityDecision',
  'qualityAuthorityDecision',
  'promotedAt',
] as const;
function checkedEvidenceSet(input: readonly AggregateReference[]): readonly AggregateReference[] {
  const evidence = checkedAggregates(input, 'promotion receipt.evidence', true, ['evidence']);
  const byDigest = evidence.map((reference) => ({ reference, digest: digest(reference) }));
  if (new Set(byDigest.map((entry) => entry.digest)).size !== byDigest.length) {
    reject('promotion receipt.evidence must be a unique reference set');
  }
  byDigest.sort((a, b) => compareCanonicalText(a.digest, b.digest));
  return Object.freeze(byDigest.map((entry) => entry.reference));
}

function normalizePromotionInput(input: PromotionReceiptInput) {
  const organizationId = checkedOrganizationId(
    input.organizationId,
    'promotion receipt.organizationId',
  );
  const candidate = checkedAggregate(input.candidate, 'promotion receipt.candidate', ['candidate']);
  const policy = checkedAggregate(input.policy, 'promotion receipt.policy', ['metric_policy']);
  const evidence = checkedEvidenceSet(input.evidence);
  const technicalAuthorityDecision = checkedAggregate(
    input.technicalAuthorityDecision,
    'promotion receipt.technicalAuthorityDecision',
    ['evidence'],
  );
  if (input.qualityAuthorityDecision === null) {
    reject(
      'every promotion requires a Quality Authority decision until authoritative risk binding exists',
    );
  }
  const qualityAuthorityDecision = checkedAggregate(
    input.qualityAuthorityDecision,
    'promotion receipt.qualityAuthorityDecision',
    ['evidence'],
  );
  if (!isPromotionRiskTier(input.riskTier)) {
    reject('promotion receipt.riskTier is not supported');
  }
  if (digest(qualityAuthorityDecision) === digest(technicalAuthorityDecision)) {
    reject('Quality Authority decision must be independent from Technical Authority decision');
  }
  const evidenceDigests = new Set(evidence.map((reference) => digest(reference)));
  if (!evidenceDigests.has(digest(technicalAuthorityDecision))) {
    reject('complete evidence set must contain the Technical Authority decision reference');
  }
  if (!evidenceDigests.has(digest(qualityAuthorityDecision))) {
    reject('complete evidence set must contain the Quality Authority decision reference');
  }
  requireOneOrganization(
    organizationId,
    [candidate, policy, ...evidence, technicalAuthorityDecision, qualityAuthorityDecision],
    'promotion receipt references',
  );
  return {
    organizationId,
    aliasId: checkedId(input.aliasId, 'promotion receipt.aliasId', GOVERNANCE_ID),
    candidate,
    runSealDigest: checkedSha256(input.runSealDigest, 'promotion receipt.runSealDigest'),
    policy,
    evidence,
    riskTier: input.riskTier,
    technicalAuthorityDecision,
    qualityAuthorityDecision,
    promotedAt: checkedTimestamp(input.promotedAt, 'promotion receipt.promotedAt'),
  };
}

/** Issue the only record capable of assigning a governed model alias. */
export function signPromotionReceipt(
  input: PromotionReceiptInput,
  key: PrivateSigningKey,
): SignedPromotionReceipt {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    reject('promotion receipt input must be an object');
  }
  assertExactKeys(input, PROMOTION_INPUT_KEYS, 'promotion receipt input');
  const normalized = normalizePromotionInput(input);
  const unsigned = Object.freeze({
    schemaVersion: 'kf.ml.promotion-receipt.v1' as const,
    issuer: 'knowledge-fabric' as const,
    ...normalized,
    evidenceSetDigest: digest(normalized.evidence),
    signingKeyId: checkedId(key.id, 'promotion receipt.signingKeyId'),
  });
  return Object.freeze({
    ...unsigned,
    receiptDigest: digest(unsigned),
    signature: edSign(null, canonicalBytes(unsigned), key.privateKey).toString('base64'),
  });
}

const PROMOTION_RECEIPT_KEYS = [
  ...PROMOTION_INPUT_KEYS,
  'schemaVersion',
  'issuer',
  'evidenceSetDigest',
  'signingKeyId',
  'receiptDigest',
  'signature',
] as const;

function normalizedReceiptUnsigned(receipt: SignedPromotionReceipt) {
  assertExactKeys(receipt, PROMOTION_RECEIPT_KEYS, 'promotion receipt');
  if (
    receipt.schemaVersion !== 'kf.ml.promotion-receipt.v1' ||
    receipt.issuer !== 'knowledge-fabric'
  ) {
    reject('unsupported promotion receipt authority or version');
  }
  const normalized = normalizePromotionInput({
    organizationId: receipt.organizationId,
    aliasId: receipt.aliasId,
    candidate: receipt.candidate,
    runSealDigest: receipt.runSealDigest,
    policy: receipt.policy,
    evidence: receipt.evidence,
    riskTier: receipt.riskTier,
    technicalAuthorityDecision: receipt.technicalAuthorityDecision,
    qualityAuthorityDecision: receipt.qualityAuthorityDecision,
    promotedAt: receipt.promotedAt,
  });
  const evidenceSetDigest = checkedSha256(
    receipt.evidenceSetDigest,
    'promotion receipt.evidenceSetDigest',
  );
  if (evidenceSetDigest !== digest(normalized.evidence)) {
    reject('promotion receipt evidence-set digest does not match its references');
  }
  return {
    schemaVersion: receipt.schemaVersion,
    issuer: receipt.issuer,
    ...normalized,
    evidenceSetDigest,
    signingKeyId: checkedId(receipt.signingKeyId, 'promotion receipt.signingKeyId'),
  };
}

/** Verify that a receipt is an intact JCS record signed by a trusted KF key. */
export function verifyPromotionReceipt(
  receipt: SignedPromotionReceipt,
  publicKeys: ReadonlyMap<string, KeyObject>,
): PromotionVerification {
  const findings: PromotionVerificationFinding[] = [];
  try {
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
      return { valid: false, findings: ['malformed_record'] };
    }
    const unsigned = normalizedReceiptUnsigned(receipt);
    if (typeof receipt.receiptDigest !== 'string' || digest(unsigned) !== receipt.receiptDigest) {
      findings.push('digest_mismatch');
    }
    const signature = checkedEd25519Signature(receipt.signature, 'promotion receipt.signature');
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
