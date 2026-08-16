import type { PreservationSection } from './types.js';

export const ENGINEERING_QUALITY_SECTIONS = [
  {
    name: 'configuration-items',
    sql: `select id, item_kind, part_number, revision_label, parent_system
            from product.configuration_item order by id`,
  },
  {
    name: 'interface-contracts',
    sql: `select id, interface_kind, generation, provider, consumer, specification
            from product.interface_contract order by id`,
  },
  {
    name: 'interface-conformances',
    sql: `select id, configuration_item, interface_contract, generation, verified_by,
                 recorded_at, recorded_by
            from product.interface_conformance
           order by configuration_item, interface_contract, generation, id`,
  },
  {
    name: 'physical-bindings',
    sql: `select id, configuration_item, serial_number, installed_on, removed_on, location
            from product.physical_binding order by id`,
  },
  {
    name: 'baseline-items',
    sql: `select baseline_id, configuration_item
            from product.baseline_item order by baseline_id, configuration_item`,
  },
  {
    name: 'release-items',
    sql: `select release_id, configuration_item
            from product.release_item order by release_id, configuration_item`,
  },
  {
    name: 'effectivities',
    sql: `select id, subject_id, applies_from, applies_to, note
            from product.effectivity order by subject_id, id`,
  },
  {
    name: 'decision-alternatives',
    sql: `select id, decision_id, summary, rejected_because
            from engineering.decision_alternative order by decision_id, id`,
  },
  {
    name: 'change-items',
    sql: `select id, change_id, subject_id, impact, note
            from engineering.change_item order by change_id, subject_id, id`,
  },
  {
    name: 'risk-controls',
    sql: `select id, control_kind, mitigates, description, implemented_in
            from engineering.risk_control order by id`,
  },
  {
    name: 'test-definitions',
    sql: `select id, method_kind, acceptance_criterion, verifies, procedure_version
            from engineering.test_definition order by id`,
  },
  {
    name: 'test-executions',
    sql: `select id, test_definition, executed_on, executed_by, configuration_item,
                 result_summary, evidence_version, invalidated_because
            from engineering.test_execution order by test_definition, id`,
  },
  {
    name: 'test-execution-equipment',
    sql: `select execution_id, equipment_id
            from engineering.test_execution_equipment order by execution_id, equipment_id`,
  },
  {
    name: 'verification-links',
    sql: `select id, subject_id, execution_id, created_at, created_by, authorizing_action
            from engineering.verification_link order by subject_id, execution_id, id`,
  },
  {
    name: 'federated-sources',
    sql: `select id, description, repository, writable
            from quality.federated_source order by id`,
  },
  {
    name: 'federated-references',
    sql: `select id, source_id, external_id, commit_sha, path, content_sha256, title,
                 verified_at, recorded_at, recorded_by
            from quality.federated_reference order by source_id, external_id, commit_sha, id`,
  },
  {
    name: 'federated-links',
    sql: `select id, object_id, reference_id, link_kind, created_at, created_by,
                 authorizing_action
            from quality.federated_link order by object_id, reference_id, link_kind, id`,
  },
  {
    name: 'nonconformities',
    sql: `select id, severity, detected_on, description, disposition, subject_id, containment
            from quality.nonconformity order by id`,
  },
  {
    name: 'capas',
    sql: `select id, capa_kind, problem_statement, root_cause, effectiveness_criterion,
                 effectiveness_evidence, closed_at
            from quality.capa order by id`,
  },
  {
    name: 'capa-nonconformities',
    sql: `select capa_id, nonconformity_id
            from quality.capa_nonconformity order by capa_id, nonconformity_id`,
  },
  {
    name: 'suppliers',
    sql: `select id, organization, criticality, qualified_until, scope_of_supply
            from quality.supplier order by id`,
  },
  {
    name: 'supplier-qualifications',
    sql: `select id, supplier_id, method, performed_on, outcome, evidence_version, recorded_by,
                 recorded_at
            from quality.supplier_qualification order by supplier_id, performed_on, id`,
  },
  {
    name: 'equipment',
    sql: `select id, asset_number, equipment_kind, calibration_due, location
            from quality.equipment order by id`,
  },
  {
    name: 'calibrations',
    sql: `select id, equipment_id, performed_on, due_on, outcome, reference_standard,
                 certificate_version, recorded_by, recorded_at
            from quality.calibration order by equipment_id, performed_on, id`,
  },
  {
    name: 'complaints',
    sql: `select id, received_on, summary, reporter_reference, affected_binding, reportable,
                 reportability_rationale, closed_at
            from quality.complaint order by id`,
  },
  {
    name: 'training-requirements',
    sql: `select role_id, document_id
            from quality.training_requirement order by role_id, document_id`,
  },
  {
    name: 'training-records',
    sql: `select id, person_id, document_id, completed_on, revision, recorded_by, recorded_at
            from quality.training_record order by person_id, document_id, revision, id`,
  },
] as const satisfies readonly PreservationSection[];
