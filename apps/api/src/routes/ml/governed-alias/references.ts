import type { AggregateReference } from '@kf/ml-registry';

import { decodeCanonicalReference, decodePositiveInteger } from '../projection.js';
import type { GovernedAliasEvidenceRow } from './contracts.js';
import { GovernedAliasUnverifiable } from './error.js';

export function sameAggregate(left: AggregateReference, right: AggregateReference): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.kind === right.kind &&
    left.authorityId === right.authorityId &&
    left.revisionId === right.revisionId &&
    left.sha256 === right.sha256 &&
    left.classificationId === right.classificationId &&
    left.policyId === right.policyId
  );
}

export function decodeEvidence(row: GovernedAliasEvidenceRow, index: number): AggregateReference {
  if (decodePositiveInteger(row.ordinal, 'governedAlias.evidence.ordinal') !== index + 1) {
    throw new GovernedAliasUnverifiable();
  }
  return decodeCanonicalReference(
    {
      organizationId: row.evidence_organization_id,
      kind: row.evidence_kind,
      authorityId: row.evidence_authority_id,
      revisionId: row.evidence_revision_id,
      sha256: row.evidence_sha256,
      classificationId: row.evidence_classification_id,
      policyId: row.evidence_policy_id,
    },
    'governedAlias.evidence.reference',
    ['evidence'],
  );
}
