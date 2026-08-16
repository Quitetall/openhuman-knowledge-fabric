import type { KeyObject } from 'node:crypto';
import { compareCanonicalText } from '@kf/canonicalization';
import type {
  GovernedAliasResolution,
  SignedPromotionReceipt,
  SignedPromotionRevocation,
} from './contracts.js';
import { verifyPromotionReceipt } from './promotion-receipts.js';
import { verifyPromotionRevocation } from './promotion-revocations.js';
import { GOVERNANCE_ID, checkedId, checkedOrganizationId, checkedTimestamp } from './validation.js';

/**
 * Resolve a governed alias from signed append-only records.
 *
 * Revoking the latest receipt leaves the alias unassigned; it never silently falls back to
 * an older candidate. A new signed receipt is required to promote again. Callers may supply
 * one canonical evaluation instant for deterministic historical or replay resolution.
 */
export function resolveGovernedAlias(
  organizationInput: string,
  aliasInput: string,
  receipts: readonly SignedPromotionReceipt[],
  revocations: readonly SignedPromotionRevocation[],
  publicKeys: ReadonlyMap<string, KeyObject>,
  evaluatedAtInput: string = new Date().toISOString(),
): GovernedAliasResolution {
  const organizationId = checkedOrganizationId(organizationInput, 'governed alias organization');
  const aliasId = checkedId(aliasInput, 'governed alias', GOVERNANCE_ID);
  const evaluatedAt = checkedTimestamp(evaluatedAtInput, 'governed alias evaluation instant');
  const scoped = receipts.filter(
    (receipt) => receipt.organizationId === organizationId && receipt.aliasId === aliasId,
  );
  if (scoped.length === 0) {
    return Object.freeze({
      status: 'unassigned',
      organizationId,
      aliasId,
      findings: Object.freeze([]),
    });
  }
  const invalidReceipt = scoped.find(
    (receipt) => !verifyPromotionReceipt(receipt, publicKeys).valid,
  );
  if (invalidReceipt !== undefined) {
    return Object.freeze({
      status: 'invalid',
      organizationId,
      aliasId,
      findings: Object.freeze(['invalid_promotion_receipt']),
    });
  }
  const matching = scoped.filter((receipt) => receipt.promotedAt <= evaluatedAt);
  if (matching.length === 0) {
    return Object.freeze({
      status: 'unassigned',
      organizationId,
      aliasId,
      findings: Object.freeze([]),
    });
  }
  const unique = [...new Map(matching.map((receipt) => [receipt.receiptDigest, receipt])).values()];
  unique.sort((a, b) => compareCanonicalText(a.promotedAt, b.promotedAt));
  const latest = unique[unique.length - 1]!;
  const previous = unique[unique.length - 2];
  if (previous !== undefined && previous.promotedAt === latest.promotedAt) {
    return Object.freeze({
      status: 'invalid',
      organizationId,
      aliasId,
      findings: Object.freeze(['ambiguous_latest_receipt']),
    });
  }

  const matchingRevocations = revocations.filter(
    (revocation) =>
      revocation.organizationId === organizationId &&
      revocation.aliasId === aliasId &&
      revocation.receiptDigest === latest.receiptDigest,
  );
  let effectiveRevocations = 0;
  for (const revocation of matchingRevocations) {
    if (!verifyPromotionRevocation(revocation, publicKeys).valid) {
      return Object.freeze({
        status: 'invalid',
        organizationId,
        aliasId,
        findings: Object.freeze(['invalid_promotion_revocation']),
      });
    }
    if (revocation.revokedAt < latest.promotedAt) {
      return Object.freeze({
        status: 'invalid',
        organizationId,
        aliasId,
        findings: Object.freeze(['revocation_precedes_promotion']),
      });
    }
    if (revocation.revokedAt <= evaluatedAt) effectiveRevocations += 1;
  }
  if (effectiveRevocations > 0) {
    return Object.freeze({
      status: 'revoked',
      organizationId,
      aliasId,
      receiptDigest: latest.receiptDigest,
      findings: Object.freeze([]),
    });
  }
  return Object.freeze({
    status: 'active',
    organizationId,
    aliasId,
    candidate: latest.candidate,
    receiptDigest: latest.receiptDigest,
    findings: Object.freeze([]),
  });
}
