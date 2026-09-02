import type { PreservationSection } from './types.js';

export const CORE_SECTIONS = [
  {
    name: 'objects',
    sql: `select id, enterprise_id, object_type, authority_domain, lifecycle_state,
                 classification, retention_class, schema_version, organization_id,
                 row_version, title, created_at, created_by, updated_at, updated_by
            from core.object order by id`,
  },
  {
    name: 'relations',
    sql: `select id, relation_type, source_id, target_id, state, properties,
                 valid_from, valid_to, created_at, created_by, authorizing_action
            from core.relation order by id`,
  },
  {
    name: 'actions',
    sql: `select id, organization_id, request_digest, action_type, actor_id, acting_role_id,
                 target_ids, parameters, preconditions, idempotency_key, recorded_at,
                 effective_at, request_id, reason, result_status, result
            from core.action order by id`,
  },
  {
    name: 'legacy-action-provenance',
    sql: `select action_id, migration_version
            from core.action_migration019_legacy order by action_id`,
  },
  {
    name: 'approvals',
    sql: `select id, object_id, action_id, approver_id, approver_role, meaning,
                 recorded_at, effective_at
            from core.approval order by id`,
  },
  {
    name: 'snapshots',
    sql: `select id, object_id, action_id, object_revision, payload, payload_sha256,
                 ontology_digest, storage_uri, recorded_at
            from core.snapshot order by id`,
  },
  {
    name: 'audit-events',
    // Ordered by seq, not id: the chain is DEFINED over this order, so exporting it any
    // other way would make the imported chain unverifiable.
    sql: `select seq, id, action_id, actor_id, acting_role_id, action_type, object_id,
                 recorded_at, effective_at, request_id, reason, before_digest, after_digest,
                 prev_digest, digest
            from core.audit_event order by seq`,
  },
  {
    name: 'audit-checkpoints',
    sql: `select id, format_version, from_seq, to_seq, leaf_count, merkle_root, signature,
                 signing_key_id, storage_uri, recorded_at
            from core.audit_checkpoint order by from_seq`,
  },
  {
    name: 'artifacts',
    // The INDEX, not the bytes. Restoring a system means restoring this alongside the object
    // store; the digest is what proves the two still agree.
    //
    // Artifacts and versions are separate sections rather than one convenient join, because
    // a join cannot be imported: its columns span two tables, so an export shaped that way
    // would look complete and restore as nothing.
    sql: 'select id, artifact_kind, source_system from content.artifact order by id',
  },
  {
    name: 'artifact-versions',
    sql: `select id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
                 storage_uri, storage_version, created_at, created_by, created_by_action
            from content.artifact_version order by artifact_id, version_no`,
  },
  {
    name: 'artifact-stores',
    sql: `select id, kind, label, writable, declared_at, notes
            from content.artifact_store order by id`,
  },
  {
    name: 'artifact-locations',
    sql: `select id, version_id, store_id, role, uri, store_version, recorded_at, recorded_by,
                 recorded_by_action, verified_at, verified_sha256, verification_failure,
                 verified_by_action
            from content.artifact_location order by version_id, role, store_id, id`,
  },
  {
    name: 'artifact-relationships',
    sql: `select id, from_version, to_version, relationship, created_at
            from content.artifact_relationship order by id`,
  },
  {
    name: 'external-identifiers',
    sql: `select id, version_id, system, external_id, uri, authority, synced_at
            from content.external_locator order by version_id, system, external_id`,
  },
  {
    name: 'organizations',
    sql: `select id, legal_name, organization_kind, jurisdiction from org.organization order by id`,
  },
  {
    name: 'people',
    sql: 'select id, display_name, organization, email from org.person order by id',
  },
  {
    name: 'engagements',
    sql: `select id, principal_organization, counterparty, engagement_kind, starts_on,
                 ends_on, agreement_artifact
            from org.engagement order by id`,
  },
  {
    name: 'role-assignments',
    sql: `select id, subject_id, role_id, scope_id, classification_ceiling, valid_from, valid_to, delegated_by
            from org.role_assignment order by id`,
  },
  {
    name: 'identifier-sequences',
    sql: `select qualified_code, next_sequence, allocated_count, updated_at
            from registry.identifier_sequence order by qualified_code`,
  },
  {
    name: 'identifier-allocations',
    sql: `select enterprise_id, object_id, qualified_code, sequence, allocated_at, allocated_by,
                 allocated_by_action
            from registry.identifier_allocation order by qualified_code, sequence`,
  },
  {
    name: 'person-clearances',
    sql: `select id, subject_id, organization_id, max_classification, valid_from, valid_to,
                 granted_by, granted_at, granted_by_action, reason
            from org.person_clearance order by organization_id, subject_id, valid_from, id`,
  },
  {
    name: 'person-clearance-retirements',
    sql: `select clearance_id, retired_at, retired_by, retirement_reason, retired_by_action
            from org.person_clearance_retirement order by retired_at, clearance_id`,
  },
  {
    // Ordered by id (uuidv7, time-ordered) so a delegated grant follows the one it came from.
    name: 'access-grants',
    sql: `select id, organization_id, principal_kind, principal_id, capability, scope_object_id,
                 classification_ceiling, valid_from, valid_to, granted_by, granted_at,
                 granted_by_action, delegated_from, reason, revoked_at, revoked_by,
                 revoked_by_action, revocation_reason
            from org.access_grant order by id`,
  },
  {
    name: 'recovery-objectives',
    sql: `select id, rpo_seconds, restore_drill_days, requires_pitr, declared_by,
                 declared_at, rationale, rto_seconds
            from ops.recovery_objective order by declared_at, id`,
  },
  {
    name: 'backup-runs',
    sql: `select id, started_at, finished_at, kind, location, manifest_digest, byte_size,
                 database_name, recorded_at
            from ops.backup_run order by started_at, id`,
  },
  {
    name: 'backup-copies',
    sql: `select id, backup_run_id, destination_label, offsite, copied_at, manifest_digest
            from ops.backup_copy order by backup_run_id, id`,
  },
  {
    name: 'restore-drills',
    sql: `select id, backup_run_id, verified_at, target_label, outcome, notes, recovery_seconds,
                 database_verified, database_snapshot_sha256, checkpoint_verified,
                 checkpoint_proof_sha256, object_store_verified, object_store_proof_ref,
                 object_store_proof_sha256
            from ops.restore_drill order by verified_at, id`,
  },
  {
    name: 'physical-failure-domain-evidence',
    sql: `select domain_ref, evidence_ref, approved_by, approved_at, valid_until
            from ops.physical_failure_domain_evidence order by domain_ref`,
  },
  {
    name: 'encrypted-backup-evidence',
    sql: `select backup_copy_id, failure_domain_ref, evidence_ref, encrypted,
                 separate_from_primary, approved_by, approved_at, valid_until
            from ops.encrypted_backup_evidence order by backup_copy_id`,
  },
] as const satisfies readonly PreservationSection[];
