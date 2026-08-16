import type { Tx } from '@kf/database';
import { verifyPromotionReceipt, type SignedPromotionReceipt } from '@kf/ml-registry';
import { readTrustedPromotionKey } from './promotion-key.js';
import type {
  GovernedAliasEvidenceRow,
  GovernedAliasProjection,
  GovernedAliasRow,
} from './governed-alias/contracts.js';
import { GovernedAliasUnverifiable } from './governed-alias/error.js';
import { decodeEvidence, sameAggregate } from './governed-alias/references.js';
import {
  canonicalRefSelect,
  decodeBoolean,
  decodeCanonicalReference,
  decodeIsoTimestamp,
  decodeRiskTier,
  decodeSha256,
  decodeString,
  ProjectionError,
} from './projection.js';
import { canonicalBase64 } from './validation.js';

export { GovernedAliasUnverifiable } from './governed-alias/error.js';

export async function readGovernedAlias(
  tx: Tx,
  organizationId: string,
  aliasId: string,
): Promise<GovernedAliasProjection> {
  const row = await tx.maybeOne<GovernedAliasRow>(
    `/* ml.governed-alias */
     select receipt.id::text as promotion_receipt_id,
            governed.organization_id::text as organization_id,
            governed.alias_id,
            seal.seal_sha256 as run_seal_sha256,
            governed.evidence_manifest_sha256,
            governed.risk_tier,
            governed.promoted_at,
            governed.promoted_at = date_trunc('milliseconds', governed.promoted_at)
              as promoted_at_has_canonical_precision,
            governed.signing_key_id,
            governed.receipt_sha256,
            governed.signature,
            ${canonicalRefSelect('candidate_ref', 'candidate')},
            ${canonicalRefSelect('policy_ref', 'policy')},
            ${canonicalRefSelect('technical_ref', 'technical')},
            ${canonicalRefSelect('quality_ref', 'quality')}
       from ml.governed_alias governed
       join ml.promotion_receipt receipt
         on receipt.organization_id = governed.organization_id
        and receipt.receipt_sha256 = governed.receipt_sha256
       join ml.run_seal seal on seal.id = governed.run_seal_id
       join ml.aggregate_reference candidate_ref on candidate_ref.id = governed.candidate_ref_id
       join ml.aggregate_reference policy_ref on policy_ref.id = governed.policy_ref_id
       join ml.aggregate_reference technical_ref
         on technical_ref.id = governed.technical_authority_decision_ref_id
       left join ml.aggregate_reference quality_ref
         on quality_ref.id = governed.quality_authority_decision_ref_id
      where governed.alias_id = $1`,
    [aliasId],
  );

  if (row === undefined) {
    // governed_alias ranks first, then suppresses current receipt on receipt/key revocation.
    // Absence therefore intentionally conflates never assigned and revoked; querying history
    // here would both duplicate database authority and create a revocation side channel.
    return {
      schemaVersion: 'kf.ml.governed-alias.v1',
      status: 'unassigned',
      organizationId,
      aliasId,
    };
  }

  try {
    if (
      decodeString(row.organization_id, 'governedAlias.organizationId') !== organizationId ||
      decodeString(row.alias_id, 'governedAlias.aliasId') !== aliasId ||
      !decodeBoolean(
        row.promoted_at_has_canonical_precision,
        'governedAlias.promotedAtHasCanonicalPrecision',
      )
    ) {
      throw new GovernedAliasUnverifiable();
    }

    const promotionReceiptId = decodeString(
      row.promotion_receipt_id,
      'governedAlias.promotionReceiptId',
    );
    const evidenceRows = await tx.query<GovernedAliasEvidenceRow>(
      `/* ml.governed-alias-evidence */
       select evidence.ordinal,
              ${canonicalRefSelect('evidence_ref', 'evidence')}
         from ml.promotion_receipt_evidence evidence
         join ml.aggregate_reference evidence_ref on evidence_ref.id = evidence.evidence_ref_id
        where evidence.promotion_receipt_id = $1::uuid
        order by evidence.ordinal`,
      [promotionReceiptId],
    );
    if (evidenceRows.length === 0) throw new GovernedAliasUnverifiable();
    const evidence = evidenceRows.map(decodeEvidence);

    const signingKeyId = decodeString(row.signing_key_id, 'governedAlias.signingKeyId');
    const promotedAt = decodeIsoTimestamp(row.promoted_at, 'governedAlias.promotedAt');
    const trustedKey = await readTrustedPromotionKey(tx, organizationId, signingKeyId, promotedAt);
    if (trustedKey === undefined) throw new GovernedAliasUnverifiable();

    const candidate = decodeCanonicalReference(
      {
        organizationId: row.candidate_organization_id,
        kind: row.candidate_kind,
        authorityId: row.candidate_authority_id,
        revisionId: row.candidate_revision_id,
        sha256: row.candidate_sha256,
        classificationId: row.candidate_classification_id,
        policyId: row.candidate_policy_id,
      },
      'governedAlias.candidate',
      ['candidate'],
    );
    const policy = decodeCanonicalReference(
      {
        organizationId: row.policy_organization_id,
        kind: row.policy_kind,
        authorityId: row.policy_authority_id,
        revisionId: row.policy_revision_id,
        sha256: row.policy_sha256,
        classificationId: row.policy_classification_id,
        policyId: row.policy_policy_id,
      },
      'governedAlias.policy',
      ['metric_policy'],
    );
    const technicalDecision = decodeCanonicalReference(
      {
        organizationId: row.technical_organization_id,
        kind: row.technical_kind,
        authorityId: row.technical_authority_id,
        revisionId: row.technical_revision_id,
        sha256: row.technical_sha256,
        classificationId: row.technical_classification_id,
        policyId: row.technical_policy_id,
      },
      'governedAlias.technicalAuthorityDecision',
      ['evidence'],
    );
    const qualityDecision = decodeCanonicalReference(
      {
        organizationId: row.quality_organization_id,
        kind: row.quality_kind,
        authorityId: row.quality_authority_id,
        revisionId: row.quality_revision_id,
        sha256: row.quality_sha256,
        classificationId: row.quality_classification_id,
        policyId: row.quality_policy_id,
      },
      'governedAlias.qualityAuthorityDecision',
      ['evidence'],
    );
    const riskTier = decodeRiskTier(row.risk_tier, 'governedAlias.riskTier');
    const allReferences = [candidate, policy, technicalDecision, qualityDecision, ...evidence];
    if (
      allReferences.some((reference) => reference.organizationId !== organizationId) ||
      !evidence.some((reference) => sameAggregate(reference, technicalDecision)) ||
      !evidence.some((reference) => sameAggregate(reference, qualityDecision))
    ) {
      throw new GovernedAliasUnverifiable();
    }

    const runSealDigest = decodeSha256(row.run_seal_sha256, 'governedAlias.runSealDigest');
    const evidenceSetDigest = decodeSha256(
      row.evidence_manifest_sha256,
      'governedAlias.evidenceSetDigest',
    );
    const receiptDigest = decodeSha256(row.receipt_sha256, 'governedAlias.receiptDigest');
    const signature = decodeString(row.signature, 'governedAlias.signature');
    if (canonicalBase64(signature, 64) === undefined) throw new GovernedAliasUnverifiable();

    const receipt: SignedPromotionReceipt = {
      schemaVersion: 'kf.ml.promotion-receipt.v1',
      issuer: 'knowledge-fabric',
      organizationId,
      aliasId,
      candidate,
      runSealDigest,
      policy,
      evidence,
      evidenceSetDigest,
      riskTier,
      technicalAuthorityDecision: technicalDecision,
      qualityAuthorityDecision: qualityDecision,
      promotedAt,
      signingKeyId,
      receiptDigest,
      signature,
    };
    if (!verifyPromotionReceipt(receipt, new Map([[signingKeyId, trustedKey.publicKey]])).valid) {
      throw new GovernedAliasUnverifiable();
    }

    return {
      schemaVersion: 'kf.ml.governed-alias.v1',
      status: 'active',
      organizationId,
      aliasId,
      receipt,
      verificationKey: trustedKey.projection,
    };
  } catch (error: unknown) {
    if (error instanceof GovernedAliasUnverifiable || error instanceof ProjectionError) {
      throw new GovernedAliasUnverifiable();
    }
    throw error;
  }
}
