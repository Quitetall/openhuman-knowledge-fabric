import type { PreservationSection } from './types.js';

export const SECURE_RUNTIME_SECTIONS = [
  {
    name: 'secure-object-authority-signing-keys',
    sql: `select id, organization_id, external_authority_ref, key_id, algorithm,
                 public_key_spki_der_base64, public_key_sha256, rotates_key_registry_id,
                 valid_from, valid_until, actor_id, action_id, registered_at
            from secure_object.authority_signing_key
           order by organization_id, external_authority_ref, valid_from, id`,
  },
  {
    name: 'secure-object-authority-signing-key-revocations',
    sql: `select signing_key_registry_id, reason_code, actor_id, action_id, revoked_at
            from secure_object.authority_signing_key_revocation
           order by signing_key_registry_id`,
  },
  {
    name: 'secure-object-capability-requests',
    sql: `select id, organization_id, classification_id, external_authority_ref,
                 external_revision_ref, external_content_sha256, purpose,
                 workload_identity_ref, policy_decision_ref, idempotency_key, ttl_seconds,
                 actor_id, action_id, requested_at, expires_at
            from secure_object.capability_request order by organization_id, requested_at, id`,
  },
  {
    name: 'secure-object-capability-issues',
    sql: `select id, request_id, external_content_sha256, purpose, workload_identity_ref,
                 policy_decision_ref, access_mode, actor_id, action_id, issued_at
            from secure_object.capability_issue order by request_id`,
  },
  {
    name: 'secure-object-capability-revocations',
    sql: `select capability_id, external_content_sha256, purpose, workload_identity_ref,
                 policy_decision_ref, actor_id, action_id, revoked_at
            from secure_object.capability_revocation order by capability_id`,
  },
  {
    name: 'secure-object-capability-consumptions',
    sql: `select capability_id, external_content_sha256, purpose, workload_identity_ref,
                 policy_decision_ref, actor_id, action_id, consumed_at
            from secure_object.capability_consumption order by capability_id`,
  },
  {
    name: 'secure-object-erasure-requests',
    sql: `select id, organization_id, classification_id, external_authority_ref,
                 external_revision_ref, external_content_sha256, purpose,
                 workload_identity_ref, policy_decision_ref, actor_id, action_id, requested_at
            from secure_object.erasure_request order by organization_id, requested_at, id`,
  },
  {
    name: 'secure-object-erasure-tombstones',
    sql: `select id, erasure_request_id, external_content_sha256, purpose,
                 workload_identity_ref, policy_decision_ref, tombstone_version, erased_at,
                 actor_id, action_id, signing_key_registry_id, signing_key_id, signature,
                 recorded_at
            from secure_object.erasure_tombstone order by erased_at, id`,
  },
  {
    name: 'outbox-events',
    sql: `select id, action_id, topic, payload, created_at, delivered_at
            from core.outbox order by created_at, id`,
  },
  {
    name: 'retention-holds',
    sql: `select id, object_id, reason, placed_by, placed_at, released_at
            from core.retention_hold order by object_id, placed_at, id`,
  },
  {
    name: 'roles',
    sql: 'select id, description from org.role order by id',
  },
  {
    name: 'external-identities',
    sql: `select id, issuer, subject, person_id, provider_label, linked_at, linked_by, revoked_at
            from org.external_identity order by issuer, subject, id`,
  },
  {
    name: 'project-memberships',
    sql: `select id, project_id, person_id, valid_from, valid_to
            from org.project_membership order by project_id, person_id, valid_from, id`,
  },
  {
    name: 'document-parses',
    sql: `select id, artifact_version_id, parser, parser_version, content_digest, created_at,
                 created_by, created_by_action, projection_contract, conversion_loss,
                 source_digest, loss_digest, loss_preimage, projection_preimage
            from content.document_parse order by artifact_version_id, id`,
  },
  {
    name: 'document-atoms',
    sql: `select id, parse_id, ordinal, atom_kind, heading_level, text_content, attributes,
                 atom_digest, atom_preimage
            from content.document_atom order by parse_id, ordinal, id`,
  },
] as const satisfies readonly PreservationSection[];
