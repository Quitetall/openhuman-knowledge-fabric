import type { SignedPromotionReceipt } from '@kf/ml-registry';

import type { TrustedPromotionKey } from '../promotion-key.js';

interface SqlRow {
  readonly [column: string]: unknown;
}

type CanonicalReferenceColumnName =
  | 'organization_id'
  | 'kind'
  | 'authority_id'
  | 'revision_id'
  | 'sha256'
  | 'classification_id'
  | 'policy_id';

type CanonicalReferenceRow<Prefix extends string> = {
  readonly [Column in `${Prefix}_${CanonicalReferenceColumnName}`]: unknown;
};

export type GovernedAliasRow = SqlRow &
  CanonicalReferenceRow<'candidate' | 'policy' | 'technical' | 'quality'> & {
    readonly promotion_receipt_id: unknown;
    readonly organization_id: unknown;
    readonly alias_id: unknown;
    readonly run_seal_sha256: unknown;
    readonly evidence_manifest_sha256: unknown;
    readonly risk_tier: unknown;
    readonly promoted_at: unknown;
    readonly promoted_at_has_canonical_precision: unknown;
    readonly signing_key_id: unknown;
    readonly receipt_sha256: unknown;
    readonly signature: unknown;
  };

export type GovernedAliasEvidenceRow = SqlRow &
  CanonicalReferenceRow<'evidence'> & {
    readonly ordinal: unknown;
  };

export type GovernedAliasProjection =
  | {
      readonly schemaVersion: 'kf.ml.governed-alias.v1';
      readonly status: 'unassigned';
      readonly organizationId: string;
      readonly aliasId: string;
    }
  | {
      readonly schemaVersion: 'kf.ml.governed-alias.v1';
      readonly status: 'active';
      readonly organizationId: string;
      readonly aliasId: string;
      readonly receipt: SignedPromotionReceipt;
      readonly verificationKey: TrustedPromotionKey['projection'];
    };
