import type { PreservationSection } from './types.js';

export const DOCUMENT_SECTIONS = [
  {
    name: 'controlled-documents',
    sql: `select id, document_class, document_number, revision, owning_role,
                 effective_from, content_version
            from quality.controlled_document order by id`,
  },
  {
    name: 'document-subjects',
    sql: `select id, object_id, subject_kind, stable_key, document_policy, current_holder_id,
                 created_at, created_by, created_by_action
            from content.document_subject order by id`,
  },
  {
    name: 'document-source-holders',
    sql: `select id, subject_id, previous_holder_id, holder_kind, fabric_artifact_version_id,
                 git_repository, git_commit_sha, git_path, git_submodule_commit_sha,
                 external_authority, external_revision, content_digest, conversion_loss,
                 migration_reason, reversible_migration_plan, recorded_at, recorded_by,
                 recorded_by_action
            from content.document_source_holder order by subject_id, recorded_at, id`,
  },
  {
    name: 'authored-fragments',
    sql: 'select id, subject_kind from content.authored_fragment order by id',
  },
  {
    name: 'document-compositions',
    sql: 'select id, subject_kind from content.document_composition order by id',
  },
  {
    name: 'authored-fragment-revisions',
    sql: `select id, fragment_id, previous_revision_id, holder_id, media_type, classification,
                 revision_state, content_digest, revision_digest, created_at, created_by,
                 created_by_action
            from content.authored_fragment_revision order by fragment_id, created_at, id`,
  },
  {
    name: 'composition-revisions',
    sql: `select id, composition_id, previous_revision_id, revision_digest, created_at,
                 created_by, created_by_action
            from content.composition_revision order by composition_id, created_at, id`,
  },
  {
    name: 'typed-bindings',
    sql: `select id, object_id, source_kind, object_revision, snapshot_id, selector,
                 expected_type, renderer, resolved_value, value_digest, binding_digest,
                 created_at, created_by, created_by_action
            from content.typed_binding order by id`,
  },
  {
    name: 'composition-inputs',
    sql: `select composition_revision_id, ordinal, input_role, fragment_revision_id,
                 child_composition_revision_id, resource_version_id, binding_id,
                 compiled_view_id, content_digest
            from content.composition_input order by composition_revision_id, ordinal`,
  },
  {
    name: 'document-compiler-registrations',
    sql: `select id, compiler_name, compiler_version, protocol, liminal_commit_sha,
                 cargo_lock_digest, executable_digest, runtime_closure_digest,
                 qualification_state, qualification_receipt_digest, qualification_ratified,
                 registered_at, registered_by
            from content.document_compiler_registration order by registered_at, id`,
  },
  {
    name: 'document-compiler-revocations',
    sql: `select registration_id, revoked_at, revoked_by, revocation_reason
            from content.document_compiler_revocation order by revoked_at, registration_id`,
  },
  {
    name: 'compilation-bases',
    sql: `select id, compiler_registration_id, protocol, root_composition_revision_id,
                 basis, basis_digest,
                 ontology_digest, policy_digest, target_profiles, compiler_kind,
                 compiler_name, compiler_version, liminal_commit_sha, cargo_lock_digest,
                 executable_digest, runtime_closure_digest, qualification_state,
                 qualification_receipt_digest, qualification_ratified,
                 effective_classification, finalized_at, created_at, created_by,
                 created_by_action
            from content.compilation_basis order by id`,
  },
  {
    name: 'compilation-basis-fragments',
    sql: `select basis_id, fragment_revision_id
            from content.compilation_basis_fragment order by basis_id, fragment_revision_id`,
  },
  {
    name: 'compilation-basis-compositions',
    sql: `select basis_id, composition_revision_id
            from content.compilation_basis_composition order by basis_id, composition_revision_id`,
  },
  {
    name: 'compilation-basis-bindings',
    sql: `select basis_id, binding_id
            from content.compilation_basis_binding order by basis_id, binding_id`,
  },
  {
    name: 'compilation-runs',
    sql: `select id, basis_id, compiler_registration_id, compiler_digest, dependency_digest,
                 run_status, draft_only, effective_classification, semantic_digest,
                 diagnostics, conversion_loss, hir_provenance, cir_provenance,
                 unresolved_references, omitted_subgraphs, projection_capabilities,
                 failure_code, failure_message, run_digest, recorded_at, requested_by_action,
                 recorded_by
            from content.compilation_run order by id`,
  },
  {
    name: 'compiled-views',
    // Compiled-view bytes are explicitly derived and rebuildable. The run/view receipt and
    // artifact-version digest are durable facts, so those remain in the preservation package.
    sql: `select id, compilation_run_id, target, media_type, artifact_version_id,
                 content_digest, effective_classification, recorded_at, recorded_by
            from content.compiled_view order by compilation_run_id, target`,
  },
  {
    name: 'compilation-run-preimages',
    sql: `select run_id, semantic_graph, semantic_preimage, canonical_preimage,
                 recorded_at, recorded_by
            from content.compilation_run_preimage order by run_id`,
  },
  {
    name: 'document-publication-targets',
    sql: `select id, organization_id, target_key, max_classification, policy_digest,
                 registered_at, registered_by
            from content.document_publication_target order by organization_id, target_key, id`,
  },
  {
    name: 'document-publication-target-retirements',
    sql: `select target_id, retired_at, retired_by, retirement_reason
            from content.document_publication_target_retirement order by target_id`,
  },
  {
    name: 'document-publications',
    sql: `select id, action_id, acceptance_action_id, organization_id, subject_id,
                 compiled_view_id, compiled_view_digest, controlled_document_id,
                 controlled_content_version_id, publication_target_id,
                 publication_target_policy_digest, effective_classification,
                 published_at, published_by
            from content.document_publication order by published_at, id`,
  },
  {
    name: 'master-records',
    sql: `select id, person_id, organization_id, compilation_run_id, effective_classification,
                 permission_digest, record_digest, manifest, compiled_at, recorded_at,
                 recorded_by, recorded_by_action
            from content.master_record order by organization_id, person_id, compiled_at, id`,
  },
  {
    name: 'person-entitlement-exclusions',
    sql: `select id, subject_id, organization_id, object_id, reason_class, reason, authorizer,
                 created_at, created_by_action, released_at, released_by_action
            from content.person_entitlement_exclusion order by organization_id, subject_id, id`,
  },
  {
    name: 'master-record-items',
    sql: `select master_record_id, object_id, object_type, title, classification, content_digest,
                 section, item_state, withdrawn_at, withdrawal_reason, content_payload
            from content.master_record_item order by master_record_id, section, object_id`,
  },
  {
    name: 'master-record-withholdings',
    sql: `select id, master_record_id, object_id, reason_class, reason, authorizer, withheld_at,
                 item_count
            from content.master_record_withholding order by master_record_id, id`,
  },
  {
    name: 'master-record-links',
    sql: `select id, master_record_id, token_digest, scope, issued_at, expires_at, issued_by,
                 issued_by_action
            from content.master_record_link order by issued_at, id`,
  },
  {
    name: 'master-record-link-revocations',
    sql: `select link_id, revoked_at, revoked_by, revoked_by_action, reason
            from content.master_record_link_revocation order by revoked_at, link_id`,
  },
  {
    name: 'master-record-delivery-receipts',
    sql: `select id, link_id, action_id, delivery_status, payload_digest, recorded_at, detail
            from content.master_record_delivery_receipt order by recorded_at, id`,
  },
  {
    name: 'master-record-link-access',
    sql: `select id, link_id, accessed_at, requester_hash, result, record_digest, detail
            from content.master_record_link_access order by accessed_at, id`,
  },
  {
    name: 'proposal-overlays',
    sql: `select id, subject_id, base_fragment_revision_id, base_composition_revision_id,
                 basis_id, proposal_kind, proposed_by_kind, actor_id, model_provider,
                 model_profile, model_request_id, model_provenance, operations,
                 proposal_digest, created_at, created_by_action
            from content.proposal_overlay order by id`,
  },
  {
    name: 'adr-decision-bodies',
    sql: `select id, decision_id, document_revision_id, body_state, body_digest,
                 recorded_at, recorded_by_action
            from content.adr_decision_body order by decision_id, recorded_at, id`,
  },
] as const satisfies readonly PreservationSection[];
