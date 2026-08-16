import type { PreservationSection } from './types.js';

export const ML_SECTIONS = [
  {
    name: 'ml-aggregate-references',
    sql: `select id, organization_id, aggregate_kind, authority_id, revision_id, sha256,
                 classification_id, policy_id
            from ml.aggregate_reference order by id`,
  },
  {
    name: 'ml-run-lineages',
    sql: `select id, run_ref_id, code_ref_id, recipe_ref_id, environment_ref_id,
                 metric_policy_ref_id, lineage_sha256, recorded_at
            from ml.run_lineage order by id`,
  },
  {
    name: 'ml-run-lineage-inputs',
    sql: `select run_lineage_id, ordinal, aggregate_ref_id
            from ml.run_lineage_input order by run_lineage_id, ordinal`,
  },
  {
    name: 'ml-run-lineage-outputs',
    sql: `select run_lineage_id, ordinal, aggregate_ref_id
            from ml.run_lineage_output order by run_lineage_id, ordinal`,
  },
  {
    name: 'ml-run-lineage-parent-models',
    sql: `select run_lineage_id, ordinal, aggregate_ref_id
            from ml.run_lineage_parent_model order by run_lineage_id, ordinal`,
  },
  {
    name: 'ml-metric-definitions',
    sql: `select id, definition_ref_id, metric_id, value_kind, unit_id, allowed_enum_ids
            from ml.metric_definition order by id`,
  },
  {
    name: 'ml-metric-write-authorizations',
    sql: `select id, organization_id, actor_id, acting_role_id, run_lineage_id,
                 metric_definition_id, metric_policy_ref_id, authorization_sha256,
                 authorized_at, schema_version, action_id
            from ml.metric_write_authorization order by organization_id, authorized_at, id`,
  },
  {
    name: 'ml-metric-events',
    sql: `select id, run_lineage_id, metric_definition_id, metric_write_authorization_id,
                 idempotency_key, sequence_no, recorded_at, numeric_value, enum_value,
                 timestamp_value, event_sha256, status
            from ml.metric_event order by run_lineage_id, sequence_no`,
  },
  {
    name: 'ml-metric-segments',
    sql: `select id, segment_ref_id, run_lineage_id, ordinal, first_sequence, last_sequence,
                 event_count, metadata_sha256, schema_version, event_manifest,
                 event_manifest_sha256
            from ml.metric_segment order by run_lineage_id, ordinal`,
  },
  {
    name: 'ml-registry-registrations',
    sql: `select record_kind, record_id, organization_id, action_id, registered_at
            from ml.registry_registration order by record_kind, record_id`,
  },
  {
    name: 'ml-run-seal-signing-keys',
    sql: `select id, organization_id, workload_identity_ref, key_id, algorithm,
                 public_key_spki_der_base64, public_key_sha256, rotates_key_registry_id,
                 valid_from, valid_until, registered_at
            from ml.run_seal_signing_key
           order by organization_id, workload_identity_ref, valid_from, id`,
  },
  {
    name: 'ml-run-seals',
    sql: `select id, run_lineage_id, lineage_sha256, segment_manifest,
                 segment_manifest_sha256, event_count, sealed_at, signing_key_id,
                 signing_key_registry_id, seal_sha256, signature, recorded_at, schema_version,
                 event_manifest_sha256
            from ml.run_seal order by id`,
  },
  {
    name: 'ml-run-seal-signing-key-revocations',
    sql: `select signing_key_registry_id, reason_code, revoked_at
            from ml.run_seal_signing_key_revocation order by signing_key_registry_id`,
  },
  {
    name: 'ml-promotion-authority-decisions',
    sql: `select object_id, organization_id, action_id, approval_id, evidence_ref_id,
                 approver_id, approver_role_id, authority_kind, alias_id, candidate_ref_id,
                 run_seal_id, policy_ref_id, risk_tier, decision_claim_sha256, effective_at,
                 valid_until, recorded_at
            from ml.promotion_authority_decision
           order by organization_id, alias_id, authority_kind, effective_at, object_id`,
  },
  {
    name: 'ml-promotion-signing-keys',
    sql: `select id, organization_id, key_id, algorithm, public_key_spki_der_base64,
                 public_key_sha256, rotates_key_registry_id, valid_from, valid_until,
                 registered_at
            from ml.promotion_signing_key order by organization_id, registered_at, id`,
  },
  {
    name: 'ml-promotion-signing-key-revocations',
    sql: `select signing_key_registry_id, reason_code, revoked_at
            from ml.promotion_signing_key_revocation order by signing_key_registry_id`,
  },
  {
    name: 'ml-promotion-receipts',
    sql: `select id, organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
                 evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
                 quality_authority_decision_ref_id, promoted_at, signing_key_id, receipt_sha256,
                 signature, recorded_at
            from ml.promotion_receipt order by organization_id, alias_id, promoted_at, id`,
  },
  {
    name: 'ml-promotion-receipt-evidence',
    sql: `select promotion_receipt_id, ordinal, evidence_ref_id
            from ml.promotion_receipt_evidence order by promotion_receipt_id, ordinal`,
  },
  {
    name: 'ml-promotion-revocations',
    sql: `select id, organization_id, receipt_id, alias_id, reason_code, revoked_at,
                 signing_key_id, revocation_sha256, signature, recorded_at
            from ml.promotion_revocation order by organization_id, id`,
  },
] as const satisfies readonly PreservationSection[];
