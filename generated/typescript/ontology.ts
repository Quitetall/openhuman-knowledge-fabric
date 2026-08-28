// GENERATED from ontology/ — do not edit.
// ontology_version: 1.1.0-draft.1
// source_digest: f6cb47b34c251067301c35868123c12dd6b6aabafeff9cbdd309cd18a9584790

/* eslint-disable */

export const SCHEMA_VERSION = '1.1.0-draft.1' as const;
export const ONTOLOGY_SOURCE_DIGEST = 'f6cb47b34c251067301c35868123c12dd6b6aabafeff9cbdd309cd18a9584790' as const;

export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Classifications = (typeof CLASSIFICATIONS)[number];

export const SOURCE_AUTHORITIES = ['knowledge_fabric', 'plm', 'qms', 'finance', 'hr', 'git', 'external'] as const;
export type SourceAuthorities = (typeof SOURCE_AUTHORITIES)[number];

export const AUTHORITY_DOMAINS = ['artifact', 'commercial', 'configuration', 'engineering', 'finance', 'organization', 'project', 'qms'] as const;
export type AuthorityDomains = (typeof AUTHORITY_DOMAINS)[number];

export const OBJECT_TYPES = ['organization', 'person', 'role_assignment', 'engagement', 'product_system', 'initiative_project', 'work_package', 'work_order', 'work_execution', 'decision_record', 'change_record', 'deliverable', 'artifact', 'acceptance_record', 'invoice', 'payment', 'requirement', 'risk', 'test', 'release', 'baseline', 'configuration_item', 'interface_contract', 'physical_binding', 'controlled_document', 'authored_fragment', 'document_composition', 'ml_promotion_decision', 'nonconformity', 'capa', 'supplier', 'equipment', 'complaint', 'risk_control', 'test_definition', 'test_execution', 'milestone', 'work_order_amendment'] as const;
export type ObjectTypes = (typeof OBJECT_TYPES)[number];

export const RELATION_TYPES = ['contains', 'decomposes_into', 'affects', 'authorizes', 'executes', 'produces', 'consumes', 'proposes', 'governs', 'implements', 'satisfies', 'verifies', 'mitigates', 'accepts', 'bills', 'settles', 'allocates_to', 'originated_from', 'supersedes', 'derived_from', 'evidences', 'assigned_to', 'scoped_to', 'depends_on', 'blocks', 'released_by', 'baseline_contains', 'performed_by', 'owned_by', 'linked_to', 'amends', 'extends', 'generated_by', 'used', 'was_associated_with', 'conforms_to', 'bound_to', 'supplied_by', 'calibrated_with', 'raised_against', 'remediated_by'] as const;
export type RelationTypes = (typeof RELATION_TYPES)[number];

export const ACTION_TYPES = ['create_initiative', 'triage_initiative', 'authorize_project', 'activate_project', 'create_work_package', 'start_work_package', 'accept_work_package', 'issue_work_order', 'accept_work_order', 'amend_work_order', 'submit_work_execution', 'review_work_execution', 'issue_acceptance', 'propose_decision', 'accept_decision', 'reject_decision', 'supersede_decision', 'open_change', 'approve_change', 'verify_change', 'make_change_effective', 'submit_invoice', 'approve_invoice', 'authorize_payment', 'record_payment_settlement', 'reconcile_payment', 'complete_project_technical', 'close_project_administrative', 'attach_evidence', 'register_external_artifact', 'correct_record', 'promote_configuration_item', 'supersede_configuration_item', 'retire_configuration_item', 'publish_interface_contract', 'deprecate_interface_contract', 'withdraw_interface_contract', 'record_physical_binding', 'remove_physical_binding', 'add_controlled_document', 'submit_document_for_review', 'approve_controlled_document', 'make_document_effective', 'supersede_controlled_document', 'withdraw_controlled_document', 'add_authored_fragment', 'revise_authored_fragment', 'retire_authored_fragment', 'add_document_composition', 'revise_document_composition', 'change_document_source_holder', 'request_document_compilation', 'compile_master_record', 'accept_document_compilation', 'publish_document_view', 'record_document_proposal', 'apply_document_proposal', 'release_person_entitlement_exclusion', 'grant_person_clearance', 'request_secure_object_access', 'issue_secure_object_capability', 'revoke_secure_object_capability', 'consume_secure_object_capability', 'request_secure_object_erasure', 'record_secure_object_erasure', 'register_secure_object_authority_key', 'revoke_secure_object_authority_key', 'register_ml_aggregate_reference', 'register_ml_run_lineage', 'register_ml_metric_definition', 'register_ml_metric_segment', 'authorize_ml_metric_stream', 'append_ml_metric_event', 'authorize_ml_promotion', 'raise_nonconformity', 'contain_nonconformity', 'investigate_nonconformity', 'disposition_nonconformity', 'close_nonconformity', 'open_capa', 'approve_capa_plan', 'implement_capa', 'check_capa_effectiveness', 'close_capa', 'register_supplier', 'qualify_supplier', 'restrict_supplier', 'disqualify_supplier', 'register_equipment', 'place_equipment_in_service', 'remove_equipment_from_service', 'quarantine_equipment', 'retire_equipment', 'receive_complaint', 'triage_complaint', 'investigate_complaint', 'close_complaint', 'propose_risk_control', 'implement_risk_control', 'verify_risk_control', 'retire_risk_control', 'define_test', 'approve_test_definition', 'supersede_test_definition', 'plan_test_execution', 'execute_test', 'record_test_result', 'invalidate_test_execution'] as const;
export type ActionTypes = (typeof ACTION_TYPES)[number];

export interface Money {
  readonly currency: string;
  readonly amount: string;
}

export interface ExternalReference {
  readonly system: string;
  readonly external_id: string;
  readonly uri?: string;
  readonly authority: 'authoritative' | 'evidence' | 'mirror' | 'lookup';
  readonly synced_at?: string;
}

export interface EvidenceReference {
  readonly node_id?: string;
  readonly uri?: string;
  readonly sha256?: string;
  readonly media_type?: string;
}

/** Organization — authority: organization */
export type OrganizationState = 'active' | 'inactive' | 'retired';
export interface OrganizationAttributes {
  readonly legal_name: string;
  readonly organization_kind: 'company' | 'supplier' | 'laboratory' | 'university' | 'regulator' | 'other';
  readonly jurisdiction?: string;
}

/** Person — authority: organization */
export type PersonState = 'active' | 'inactive';
export interface PersonAttributes {
  readonly display_name: string;
  readonly organization?: string;
  readonly email?: string;
}

/** Role Assignment — authority: organization */
export type RoleAssignmentState = 'active' | 'inactive' | 'expired';
export interface RoleAssignmentAttributes {
  readonly subject: string;
  readonly role: 'project_owner' | 'technical_authority' | 'design_authority' | 'work_order_manager' | 'performer' | 'reviewer' | 'finance_approver' | 'quality_authority' | 'configuration_authority' | 'system_administrator';
  readonly scope: string;
  readonly valid_from: string;
  readonly valid_to?: string;
  readonly delegated_by?: string;
}

/** Engagement — authority: commercial */
export type EngagementState = 'draft' | 'active' | 'suspended' | 'closed' | 'terminated';
export interface EngagementAttributes {
  readonly principal_organization: string;
  readonly counterparty: string;
  readonly engagement_kind: 'contractor' | 'supplier' | 'employee' | 'research_collaboration' | 'laboratory_service';
  readonly starts_on: string;
  readonly ends_on?: string;
  readonly agreement_artifact?: string;
  readonly commercial_terms_ref?: string;
}

/** Product or System — authority: configuration */
export type ProductSystemState = 'concept' | 'development' | 'active' | 'sustaining' | 'retired';
export interface ProductSystemAttributes {
  readonly product_kind: 'product' | 'platform' | 'subsystem' | 'service' | 'infrastructure';
  readonly responsible_owner: string;
  readonly configuration_authority?: string;
}

/** Initiative or Project — authority: project */
export type InitiativeProjectState = 'captured' | 'triage' | 'evaluating' | 'authorized' | 'active' | 'technically_complete' | 'administratively_closed' | 'parked' | 'rejected' | 'cancelled';
export interface InitiativeProjectAttributes {
  readonly idea_statement: string;
  readonly objective?: string;
  readonly project_owner: string;
  readonly affected_products: readonly string[];
  readonly scope_in?: readonly string[];
  readonly scope_out?: readonly string[];
  readonly success_criteria: readonly string[];
  readonly closure_criteria: readonly string[];
  readonly authorized_budget?: Money;
  readonly target_date?: string;
  readonly technical_status?: 'not_started' | 'active' | 'complete' | 'terminated';
  readonly administrative_status?: 'not_open' | 'open' | 'closing' | 'closed';
}

/** Work Package — authority: project */
export type WorkPackageState = 'planned' | 'ready' | 'active' | 'blocked' | 'submitted' | 'accepted' | 'waived' | 'cancelled';
export interface WorkPackageAttributes {
  readonly project: string;
  readonly wbs_code: string;
  readonly parent_work_package?: string;
  readonly outcome: string;
  readonly acceptance_criteria: readonly string[];
  readonly accountable_owner: string;
  readonly planned_start?: string;
  readonly planned_end?: string;
  readonly progress_basis: string;
  readonly weight?: string;
}

/** Work Order — authority: commercial */
export type WorkOrderState = 'draft' | 'offered' | 'accepted' | 'active' | 'suspended' | 'completed' | 'closed' | 'cancelled' | 'terminated';
export interface WorkOrderAttributes {
  readonly project: string;
  readonly engagement: string;
  readonly authorized_work_packages: readonly string[];
  readonly scope: string;
  readonly exclusions?: readonly string[];
  readonly deliverables?: readonly string[];
  readonly commercial_model: 'fixed_price' | 'milestone' | 'hourly' | 'time_and_materials' | 'not_to_exceed' | 'internal';
  readonly authorized_ceiling: Money;
  readonly starts_on?: string;
  readonly ends_on?: string;
  readonly work_order_manager: string;
  readonly acceptance_authority: string;
  readonly agreement_ref?: string;
  readonly amends_work_order?: string;
}

/** Work Execution Record — authority: commercial */
export type WorkExecutionState = 'draft' | 'submitted' | 'under_review' | 'accepted' | 'partially_accepted' | 'rejected' | 'superseded';
export interface WorkExecutionAttributes {
  readonly work_order: string;
  readonly work_packages: readonly string[];
  readonly performed_by: readonly string[];
  readonly period_start?: string;
  readonly period_end?: string;
  readonly summary: string;
  readonly changes_made?: readonly string[];
  readonly artifact_refs: readonly string[];
  readonly test_refs?: readonly string[];
  readonly deviations?: readonly string[];
  readonly decision_requests?: readonly string[];
  readonly out_of_scope_findings?: readonly string[];
  readonly submitted_at?: string;
}

/** Decision Record — authority: engineering */
export type DecisionRecordState = 'draft' | 'proposed' | 'accepted' | 'rejected' | 'superseded' | 'withdrawn';
export interface DecisionRecordAttributes {
  readonly decision_scope: string;
  readonly decision_type: 'architecture' | 'engineering' | 'process' | 'commercial' | 'policy' | 'risk';
  readonly context: string;
  readonly question: string;
  readonly options: readonly Readonly<Record<string, unknown>>[];
  readonly decision?: string;
  readonly rationale?: string;
  readonly consequences?: readonly string[];
  readonly proposer: string;
  readonly decision_authority: string;
  readonly originating_work_execution?: string;
  readonly accepted_at?: string;
  readonly supersedes?: string;
}

/** Change Record — authority: configuration */
export type ChangeRecordState = 'proposed' | 'impact_assessment' | 'approved' | 'implementing' | 'verified' | 'effective' | 'closed' | 'rejected';
export interface ChangeRecordAttributes {
  readonly affected_nodes: readonly string[];
  readonly rationale_decision?: string;
  readonly change_summary: string;
  readonly impact_domains: readonly 'requirements' | 'risk' | 'hardware' | 'software' | 'interface' | 'verification' | 'manufacturing' | 'supplier' | 'labeling' | 'regulatory' | 'training' | 'service' | 'inventory' | 'cybersecurity' | 'finance'[];
  readonly implementation_plan?: string;
  readonly verification_refs?: readonly string[];
  readonly effectivity?: string;
  readonly change_authority: string;
}

/** Deliverable — authority: project */
export type DeliverableState = 'planned' | 'submitted' | 'accepted' | 'rejected' | 'waived' | 'superseded';
export interface DeliverableAttributes {
  readonly work_package: string;
  readonly work_order?: string;
  readonly description: string;
  readonly acceptance_criteria: readonly string[];
  readonly due_date?: string;
  readonly artifact_refs?: readonly string[];
}

/** Artifact — authority: artifact */
export type ArtifactState = 'draft' | 'review' | 'released' | 'obsolete' | 'retired';
export interface ArtifactAttributes {
  readonly artifact_kind: 'document' | 'cad' | 'drawing' | 'bom' | 'source_code' | 'binary' | 'dataset' | 'model' | 'test_evidence' | 'message_snapshot' | 'invoice_evidence' | 'payment_evidence' | 'other';
  readonly uri: string;
  readonly sha256: string;
  readonly media_type: string;
  readonly size_bytes?: number;
  readonly revision?: string;
  readonly version?: string;
  readonly source_commit?: string;
  readonly generated_by?: string;
}

/** Acceptance Record — authority: commercial */
export type AcceptanceRecordState = 'draft' | 'issued' | 'superseded';
export interface AcceptanceRecordAttributes {
  readonly work_order: string;
  readonly work_execution?: string;
  readonly deliverables: readonly string[];
  readonly result: 'accepted' | 'partially_accepted' | 'rejected' | 'conditional';
  readonly criteria_results: readonly Readonly<Record<string, unknown>>[];
  readonly accepted_amount?: Money;
  readonly reviewer: string;
  readonly issued_at: string;
  readonly deficiencies?: readonly string[];
}

/** Invoice — authority: finance */
export type InvoiceState = 'draft' | 'submitted' | 'approved' | 'disputed' | 'partially_paid' | 'paid' | 'void';
export interface InvoiceAttributes {
  readonly supplier: string;
  readonly invoice_number: string;
  readonly issue_date: string;
  readonly due_date?: string;
  readonly currency: string;
  readonly line_items: readonly Readonly<Record<string, unknown>>[];
  readonly total: Money;
  readonly external_authority?: string;
}

/** Payment — authority: finance */
export type PaymentState = 'planned' | 'authorized' | 'initiated' | 'settled' | 'reconciled' | 'reversed' | 'failed';
export interface PaymentAttributes {
  readonly payee: string;
  readonly payment_date: string;
  readonly amount: Money;
  readonly payment_method: 'ach' | 'wire' | 'card' | 'platform' | 'check' | 'cash' | 'payroll' | 'other';
  readonly external_transaction_id?: string;
  readonly allocations: readonly Readonly<Record<string, unknown>>[];
  readonly fee_amount?: Money;
  readonly exchange_rate?: string;
  readonly settlement_evidence?: readonly string[];
}

/** Requirement — authority: qms */
export type RequirementState = 'draft' | 'approved' | 'implemented' | 'verified' | 'retired';
export interface RequirementAttributes {
  readonly statement: string;
  readonly requirement_kind: 'stakeholder' | 'system' | 'subsystem' | 'software' | 'process' | 'regulatory';
  readonly verification_method?: string;
}

/** Risk — authority: qms */
export type RiskState = 'identified' | 'analyzed' | 'controlled' | 'accepted' | 'closed';
export interface RiskAttributes {
  readonly risk_kind: 'hazard' | 'project' | 'technical' | 'supplier' | 'cybersecurity' | 'business';
  readonly description: string;
  readonly severity?: string;
  readonly probability?: string;
  readonly controls?: readonly string[];
}

/** Test — authority: qms */
export type TestState = 'draft' | 'approved' | 'executed' | 'passed' | 'failed' | 'retired';
export interface TestAttributes {
  readonly test_kind: 'method' | 'case' | 'protocol' | 'execution';
  readonly objective: string;
  readonly procedure_artifact?: string;
  readonly result_artifact?: string;
}

/** Release — authority: configuration */
export type ReleaseState = 'draft' | 'approved' | 'effective' | 'withdrawn';
export interface ReleaseAttributes {
  readonly release_kind: 'product' | 'document' | 'software' | 'manufacturing' | 'schema';
  readonly contained_nodes: readonly string[];
  readonly released_at?: string;
}

/** Baseline — authority: configuration */
export type BaselineState = 'draft' | 'approved' | 'superseded' | 'retired';
export interface BaselineAttributes {
  readonly baseline_kind: 'functional' | 'allocated' | 'product' | 'project' | 'manufacturing' | 'verification';
  readonly contained_nodes: readonly string[];
  readonly approved_at?: string;
}

/** Configuration Item — authority: configuration */
export type ConfigurationItemState = 'proposed' | 'active' | 'superseded' | 'retired';
export interface ConfigurationItemAttributes {
  readonly item_kind: 'hardware' | 'software' | 'firmware' | 'mechanical' | 'document' | 'tooling' | 'data';
  readonly part_number: string;
  readonly revision_label: string;
  readonly parent_system: string;
}

/** Interface Contract — authority: configuration */
export type InterfaceContractState = 'draft' | 'published' | 'deprecated' | 'withdrawn';
export interface InterfaceContractAttributes {
  readonly interface_kind: 'electrical' | 'mechanical' | 'thermal' | 'data' | 'protocol' | 'service' | 'regulatory';
  readonly generation: string;
  readonly provider: string;
  readonly consumer?: string;
}

/** Physical Binding — authority: configuration */
export type PhysicalBindingState = 'planned' | 'installed' | 'removed';
export interface PhysicalBindingAttributes {
  readonly configuration_item: string;
  readonly serial_number: string;
  readonly installed_on?: string;
}

/** Controlled Document — authority: qms */
export type ControlledDocumentState = 'draft' | 'in_review' | 'approved' | 'effective' | 'superseded' | 'withdrawn';
export interface ControlledDocumentAttributes {
  readonly document_class: 'policy' | 'procedure' | 'work_instruction' | 'form' | 'record' | 'specification' | 'plan' | 'report';
  readonly document_number: string;
  readonly revision: string;
  readonly owning_role: 'project_owner' | 'technical_authority' | 'design_authority' | 'work_order_manager' | 'performer' | 'reviewer' | 'finance_approver' | 'quality_authority' | 'configuration_authority' | 'system_administrator';
}

/** Authored Fragment — authority: qms */
export type AuthoredFragmentState = 'active' | 'retired';
export interface AuthoredFragmentAttributes {
  readonly stable_key: string;
}

/** Document Composition — authority: qms */
export type DocumentCompositionState = 'active';
export interface DocumentCompositionAttributes {
  readonly stable_key: string;
}

/** ML Promotion Decision — authority: qms */
export type MlPromotionDecisionState = 'recorded';
export interface MlPromotionDecisionAttributes {
  readonly authority_kind: 'technical' | 'quality';
  readonly alias_id: string;
  readonly candidate_ref_id: string;
  readonly run_seal_id: string;
  readonly policy_ref_id: string;
  readonly risk_tier: 'research' | 'regulated' | 'high_risk';
  readonly effective_at: string;
  readonly valid_until?: string;
}

/** Nonconformity — authority: qms */
export type NonconformityState = 'open' | 'contained' | 'investigated' | 'dispositioned' | 'closed';
export interface NonconformityAttributes {
  readonly severity: 'minor' | 'major' | 'critical';
  readonly detected_on: string;
  readonly description: string;
  readonly disposition?: 'use_as_is' | 'rework' | 'repair' | 'scrap' | 'return_to_supplier';
}

/** Corrective and Preventive Action — authority: qms */
export type CapaState = 'open' | 'plan_approved' | 'implementing' | 'effectiveness_check' | 'closed' | 'cancelled';
export interface CapaAttributes {
  readonly capa_kind: 'corrective' | 'preventive' | 'both';
  readonly problem_statement: string;
  readonly root_cause?: string;
  readonly effectiveness_criterion: string;
}

/** Supplier — authority: qms */
export type SupplierState = 'prospective' | 'qualified' | 'conditional' | 'disqualified';
export interface SupplierAttributes {
  readonly organization: string;
  readonly criticality: 'critical' | 'significant' | 'standard';
  readonly qualified_until?: string;
}

/** Equipment — authority: qms */
export type EquipmentState = 'in_service' | 'out_of_service' | 'quarantined' | 'retired';
export interface EquipmentAttributes {
  readonly asset_number: string;
  readonly equipment_kind: 'measurement' | 'production' | 'test' | 'environmental' | 'computing';
  readonly calibration_due?: string;
}

/** Complaint — authority: qms */
export type ComplaintState = 'received' | 'triaged' | 'investigated' | 'closed';
export interface ComplaintAttributes {
  readonly received_on: string;
  readonly summary: string;
  readonly reportable?: boolean;
  readonly reportability_rationale?: string;
}

/** Risk Control — authority: engineering */
export type RiskControlState = 'proposed' | 'implemented' | 'verified' | 'retired';
export interface RiskControlAttributes {
  readonly control_kind: 'inherent_safety' | 'protective_measure' | 'information_for_safety';
  readonly mitigates: string;
  readonly description: string;
}

/** Test Definition — authority: engineering */
export type TestDefinitionState = 'draft' | 'approved' | 'superseded';
export interface TestDefinitionAttributes {
  readonly method_kind: 'inspection' | 'analysis' | 'demonstration' | 'test';
  readonly acceptance_criterion: string;
  readonly verifies: string;
}

/** Test Execution — authority: engineering */
export type TestExecutionState = 'planned' | 'executed' | 'passed' | 'failed' | 'invalidated';
export interface TestExecutionAttributes {
  readonly test_definition: string;
  readonly executed_on?: string;
  readonly equipment_used?: readonly string[];
  readonly result_summary?: string;
}

/** Milestone — authority: project */
export type MilestoneState = 'planned' | 'achieved' | 'missed' | 'cancelled';
export interface MilestoneAttributes {
  readonly project: string;
  readonly planned_on: string;
  readonly criterion: string;
}

/** Work Order Amendment — authority: commercial */
export type WorkOrderAmendmentState = 'draft' | 'issued' | 'superseded';
export interface WorkOrderAmendmentAttributes {
  readonly work_order: string;
  readonly amendment_no: number;
  readonly rationale: string;
}

/** State machines, keyed by object type. */
export const STATE_MACHINES = {
  initiative_project: {
    initial: 'captured',
    terminal: ['administratively_closed', 'rejected', 'cancelled'],
    transitions: [
      { from: 'captured', to: 'triage', action: 'triage_initiative' },
      { from: 'triage', to: 'evaluating', action: 'triage_initiative' },
      { from: 'evaluating', to: 'authorized', action: 'authorize_project' },
      { from: 'authorized', to: 'active', action: 'activate_project' },
      { from: 'active', to: 'technically_complete', action: 'complete_project_technical' },
      { from: 'technically_complete', to: 'administratively_closed', action: 'close_project_administrative' },
      { from: 'captured', to: 'parked', action: 'triage_initiative' },
      { from: 'triage', to: 'parked', action: 'triage_initiative' },
      { from: 'parked', to: 'triage', action: 'triage_initiative' },
      { from: 'evaluating', to: 'rejected', action: 'triage_initiative' },
      { from: 'authorized', to: 'cancelled', action: 'correct_record' },
      { from: 'active', to: 'cancelled', action: 'correct_record' },
    ],
  },
  work_package: {
    initial: 'planned',
    terminal: ['accepted', 'waived', 'cancelled'],
    transitions: [
      { from: 'planned', to: 'ready', action: 'create_work_package' },
      { from: 'ready', to: 'active', action: 'start_work_package' },
      { from: 'active', to: 'blocked', action: 'correct_record' },
      { from: 'blocked', to: 'active', action: 'correct_record' },
      { from: 'active', to: 'submitted', action: 'submit_work_execution' },
      { from: 'submitted', to: 'accepted', action: 'accept_work_package' },
      { from: 'submitted', to: 'active', action: 'review_work_execution' },
      { from: 'planned', to: 'cancelled', action: 'correct_record' },
      { from: 'active', to: 'waived', action: 'correct_record' },
    ],
  },
  work_order: {
    initial: 'draft',
    terminal: ['closed', 'cancelled', 'terminated'],
    transitions: [
      { from: 'draft', to: 'offered', action: 'issue_work_order' },
      { from: 'offered', to: 'accepted', action: 'accept_work_order' },
      { from: 'accepted', to: 'active', action: 'accept_work_order' },
      { from: 'active', to: 'suspended', action: 'correct_record' },
      { from: 'suspended', to: 'active', action: 'correct_record' },
      { from: 'active', to: 'completed', action: 'issue_acceptance' },
      { from: 'completed', to: 'closed', action: 'correct_record' },
      { from: 'draft', to: 'cancelled', action: 'correct_record' },
      { from: 'offered', to: 'cancelled', action: 'correct_record' },
      { from: 'active', to: 'terminated', action: 'correct_record' },
    ],
  },
  work_execution: {
    initial: 'draft',
    terminal: ['accepted', 'partially_accepted', 'rejected', 'superseded'],
    transitions: [
      { from: 'draft', to: 'submitted', action: 'submit_work_execution' },
      { from: 'submitted', to: 'under_review', action: 'review_work_execution' },
      { from: 'under_review', to: 'accepted', action: 'issue_acceptance' },
      { from: 'under_review', to: 'partially_accepted', action: 'issue_acceptance' },
      { from: 'under_review', to: 'rejected', action: 'issue_acceptance' },
      { from: 'submitted', to: 'superseded', action: 'correct_record' },
    ],
  },
  decision_record: {
    initial: 'draft',
    terminal: ['rejected', 'superseded', 'withdrawn'],
    transitions: [
      { from: 'draft', to: 'proposed', action: 'propose_decision' },
      { from: 'proposed', to: 'accepted', action: 'accept_decision' },
      { from: 'proposed', to: 'rejected', action: 'reject_decision' },
      { from: 'proposed', to: 'withdrawn', action: 'correct_record' },
      { from: 'accepted', to: 'superseded', action: 'supersede_decision' },
    ],
  },
  change_record: {
    initial: 'proposed',
    terminal: ['closed', 'rejected'],
    transitions: [
      { from: 'proposed', to: 'impact_assessment', action: 'open_change' },
      { from: 'impact_assessment', to: 'approved', action: 'approve_change' },
      { from: 'impact_assessment', to: 'rejected', action: 'approve_change' },
      { from: 'approved', to: 'implementing', action: 'approve_change' },
      { from: 'implementing', to: 'verified', action: 'verify_change' },
      { from: 'verified', to: 'effective', action: 'make_change_effective' },
      { from: 'effective', to: 'closed', action: 'correct_record' },
    ],
  },
  invoice: {
    initial: 'draft',
    terminal: ['paid', 'void'],
    transitions: [
      { from: 'draft', to: 'submitted', action: 'submit_invoice' },
      { from: 'submitted', to: 'approved', action: 'approve_invoice' },
      { from: 'submitted', to: 'disputed', action: 'approve_invoice' },
      { from: 'approved', to: 'partially_paid', action: 'record_payment_settlement' },
      { from: 'approved', to: 'paid', action: 'record_payment_settlement' },
      { from: 'partially_paid', to: 'paid', action: 'record_payment_settlement' },
      { from: 'draft', to: 'void', action: 'correct_record' },
      { from: 'disputed', to: 'approved', action: 'approve_invoice' },
      { from: 'disputed', to: 'void', action: 'correct_record' },
    ],
  },
  payment: {
    initial: 'planned',
    terminal: ['reversed', 'failed'],
    transitions: [
      { from: 'planned', to: 'authorized', action: 'authorize_payment' },
      { from: 'authorized', to: 'initiated', action: 'authorize_payment' },
      { from: 'initiated', to: 'settled', action: 'record_payment_settlement' },
      { from: 'settled', to: 'reconciled', action: 'reconcile_payment' },
      { from: 'initiated', to: 'failed', action: 'record_payment_settlement' },
      { from: 'settled', to: 'reversed', action: 'correct_record' },
      { from: 'reconciled', to: 'reversed', action: 'correct_record' },
    ],
  },
  configuration_item: {
    initial: 'proposed',
    terminal: ['retired'],
    transitions: [
      { from: 'proposed', to: 'active', action: 'promote_configuration_item' },
      { from: 'active', to: 'superseded', action: 'supersede_configuration_item' },
      { from: 'superseded', to: 'retired', action: 'retire_configuration_item' },
      { from: 'active', to: 'retired', action: 'retire_configuration_item' },
      { from: 'proposed', to: 'retired', action: 'retire_configuration_item' },
    ],
  },
  interface_contract: {
    initial: 'draft',
    terminal: ['withdrawn'],
    transitions: [
      { from: 'draft', to: 'published', action: 'publish_interface_contract' },
      { from: 'published', to: 'deprecated', action: 'deprecate_interface_contract' },
      { from: 'deprecated', to: 'withdrawn', action: 'withdraw_interface_contract' },
      { from: 'draft', to: 'withdrawn', action: 'withdraw_interface_contract' },
    ],
  },
  physical_binding: {
    initial: 'planned',
    terminal: ['removed'],
    transitions: [
      { from: 'planned', to: 'installed', action: 'record_physical_binding' },
      { from: 'installed', to: 'removed', action: 'remove_physical_binding' },
      { from: 'planned', to: 'removed', action: 'remove_physical_binding' },
    ],
  },
  controlled_document: {
    initial: 'draft',
    terminal: ['withdrawn'],
    transitions: [
      { from: 'draft', to: 'in_review', action: 'submit_document_for_review' },
      { from: 'in_review', to: 'approved', action: 'approve_controlled_document' },
      { from: 'in_review', to: 'draft', action: 'approve_controlled_document' },
      { from: 'approved', to: 'effective', action: 'make_document_effective' },
      { from: 'effective', to: 'superseded', action: 'supersede_controlled_document' },
      { from: 'superseded', to: 'withdrawn', action: 'withdraw_controlled_document' },
      { from: 'draft', to: 'withdrawn', action: 'withdraw_controlled_document' },
    ],
  },
  authored_fragment: {
    initial: 'active',
    terminal: ['retired'],
    transitions: [
      { from: 'active', to: 'retired', action: 'retire_authored_fragment' },
    ],
  },
  nonconformity: {
    initial: 'open',
    terminal: ['closed'],
    transitions: [
      { from: 'open', to: 'contained', action: 'contain_nonconformity' },
      { from: 'contained', to: 'investigated', action: 'investigate_nonconformity' },
      { from: 'investigated', to: 'dispositioned', action: 'disposition_nonconformity' },
      { from: 'dispositioned', to: 'closed', action: 'close_nonconformity' },
    ],
  },
  capa: {
    initial: 'open',
    terminal: ['closed', 'cancelled'],
    transitions: [
      { from: 'open', to: 'plan_approved', action: 'approve_capa_plan' },
      { from: 'plan_approved', to: 'implementing', action: 'implement_capa' },
      { from: 'implementing', to: 'effectiveness_check', action: 'check_capa_effectiveness' },
      { from: 'effectiveness_check', to: 'closed', action: 'close_capa' },
      { from: 'effectiveness_check', to: 'implementing', action: 'check_capa_effectiveness' },
      { from: 'open', to: 'cancelled', action: 'correct_record' },
    ],
  },
  supplier: {
    initial: 'prospective',
    terminal: ['disqualified'],
    transitions: [
      { from: 'prospective', to: 'qualified', action: 'qualify_supplier' },
      { from: 'prospective', to: 'conditional', action: 'qualify_supplier' },
      { from: 'qualified', to: 'conditional', action: 'restrict_supplier' },
      { from: 'conditional', to: 'qualified', action: 'qualify_supplier' },
      { from: 'qualified', to: 'disqualified', action: 'disqualify_supplier' },
      { from: 'conditional', to: 'disqualified', action: 'disqualify_supplier' },
      { from: 'prospective', to: 'disqualified', action: 'disqualify_supplier' },
    ],
  },
  equipment: {
    initial: 'in_service',
    terminal: ['retired'],
    transitions: [
      { from: 'in_service', to: 'out_of_service', action: 'remove_equipment_from_service' },
      { from: 'out_of_service', to: 'in_service', action: 'place_equipment_in_service' },
      { from: 'in_service', to: 'quarantined', action: 'quarantine_equipment' },
      { from: 'quarantined', to: 'in_service', action: 'place_equipment_in_service' },
      { from: 'quarantined', to: 'retired', action: 'retire_equipment' },
      { from: 'out_of_service', to: 'retired', action: 'retire_equipment' },
    ],
  },
  complaint: {
    initial: 'received',
    terminal: ['closed'],
    transitions: [
      { from: 'received', to: 'triaged', action: 'triage_complaint' },
      { from: 'triaged', to: 'investigated', action: 'investigate_complaint' },
      { from: 'investigated', to: 'closed', action: 'close_complaint' },
      { from: 'triaged', to: 'closed', action: 'close_complaint' },
    ],
  },
  risk_control: {
    initial: 'proposed',
    terminal: ['retired'],
    transitions: [
      { from: 'proposed', to: 'implemented', action: 'implement_risk_control' },
      { from: 'implemented', to: 'verified', action: 'verify_risk_control' },
      { from: 'verified', to: 'implemented', action: 'verify_risk_control' },
      { from: 'verified', to: 'retired', action: 'retire_risk_control' },
      { from: 'proposed', to: 'retired', action: 'retire_risk_control' },
    ],
  },
  test_definition: {
    initial: 'draft',
    terminal: ['superseded'],
    transitions: [
      { from: 'draft', to: 'approved', action: 'approve_test_definition' },
      { from: 'approved', to: 'superseded', action: 'supersede_test_definition' },
      { from: 'draft', to: 'superseded', action: 'supersede_test_definition' },
    ],
  },
  test_execution: {
    initial: 'planned',
    terminal: ['invalidated'],
    transitions: [
      { from: 'planned', to: 'executed', action: 'execute_test' },
      { from: 'executed', to: 'passed', action: 'record_test_result' },
      { from: 'executed', to: 'failed', action: 'record_test_result' },
      { from: 'passed', to: 'invalidated', action: 'invalidate_test_execution' },
      { from: 'failed', to: 'invalidated', action: 'invalidate_test_execution' },
      { from: 'executed', to: 'invalidated', action: 'invalidate_test_execution' },
    ],
  },
} as const;

/** Machine-enforceable invariants and where each is enforced. */
export const RULES = [
  { id: 'KF-GRAPH-001', severity: 'error', implementation: ['validator'], description: "Every edge source and target resolves to a node in the same graph view or a declared federated resource." },
  { id: 'KF-WORK-001', severity: 'error', implementation: ['database_constraint', 'validator'], description: "A work_execution references exactly one work_order." },
  { id: 'KF-WORK-002', severity: 'error', implementation: ['database_constraint', 'validator'], description: "A work_order references exactly one project and one engagement." },
  { id: 'KF-DEC-001', severity: 'error', implementation: ['action_precondition', 'validator'], description: "Accepted or rejected decision records are immutable; supersession creates a new decision record." },
  { id: 'KF-CHG-001', severity: 'error', implementation: ['action_precondition', 'validator'], description: "A change record implements, but never substitutes for, the decision rationale that authorized it." },
  { id: 'KF-FIN-001', severity: 'error', implementation: ['database_constraint', 'action_precondition', 'validator'], description: "Accepted value must not exceed authorized work-order ceiling without an approved amendment." },
  { id: 'KF-FIN-002', severity: 'error', implementation: ['database_constraint', 'action_precondition', 'validator'], description: "Invoice line value must not exceed accepted value available for the referenced work order." },
  { id: 'KF-FIN-003', severity: 'error', implementation: ['database_constraint', 'action_precondition', 'validator'], description: "Payment allocations must sum to no more than the payment amount and must not exceed invoice balances." },
  { id: 'KF-PROJ-001', severity: 'error', implementation: ['validator'], description: "Project progress is computed from accepted or waived work packages, not spending or activity count." },
  { id: 'KF-PROJ-002', severity: 'error', implementation: ['action_precondition', 'validator'], description: "Administrative project closure requires technical disposition plus closure of open work orders and financial obligations." },
  { id: 'KF-DOC-001', severity: 'error', implementation: ['database_constraint', 'action_precondition', 'validator'], description: "Every authored document subject has one current Source Holder and Holder changes use the narrow typed action." },
  { id: 'KF-DOC-002', severity: 'error', implementation: ['database_constraint', 'action_precondition', 'validator'], description: "A compilation run and its views must consume the exact Basis authorized by one prior compilation request action." },
  { id: 'KF-DOC-003', severity: 'error', implementation: ['database_constraint', 'action_precondition', 'validator'], description: "Each document subject has one immutable authoritative document policy that callers cannot weaken; Holder transfer, compilation acceptance and publication require scoped technical authority plus any quality authority required by that policy." },
  { id: 'KF-DOC-004', severity: 'error', implementation: ['database_constraint', 'action_precondition', 'validator'], description: "A Proposal Overlay is append-only; applying one requires a human-authorized typed action, an applied fragment remains a live draft, and no result is official before controlled review, effectivity and publication." },
  { id: 'KF-DOC-005', severity: 'error', implementation: ['database_constraint', 'action_precondition', 'validator'], description: "Every official document publication has one append-only receipt binding the exact accepted compiler result, effective controlled content revision and registered destination policy that authorized it." },
] as const;
