<!-- GENERATED from ontology/ — do not edit. -->
<!-- ontology_version: 1.2.0-draft.1 · source_digest: 0d3dd10bb5f1a04f7e4cf40dc8b85938551d5bf441f1131d4875793dede0577e -->

# Ontology reference

Compiled from `ontology/`. 39 object types, 41 relation types, 145 action types, 22 state machines, 15 invariants, 4 corpus projections.

## Object types

| Type | Authority | Enterprise namespace | Lifecycle | States |
|---|---|---|---|---|
| `organization` | organization | — | — | 3 |
| `person` | organization | — | — | 2 |
| `role_assignment` | organization | — | — | 3 |
| `engagement` | commercial | — | — | 5 |
| `product_system` | configuration | ITM | — | 5 |
| `initiative_project` | project | PRJ *(proposed)* | initiative_project | 10 |
| `work_package` | project | — | work_package | 8 |
| `work_order` | commercial | WRK | work_order | 9 |
| `work_execution` | commercial | RCD | work_execution | 7 |
| `decision_record` | engineering | ADR | decision_record | 6 |
| `change_record` | configuration | CHG | change_record | 8 |
| `deliverable` | project | — | — | 6 |
| `artifact` | artifact | — | — | 5 |
| `acceptance_record` | commercial | RCD | — | 3 |
| `invoice` | finance | RCD | invoice | 7 |
| `payment` | finance | RCD | payment | 7 |
| `requirement` | qms | REQ | — | 5 |
| `risk` | qms | RSK | — | 5 |
| `test` | qms | TST | — | 6 |
| `release` | configuration | RLS | — | 4 |
| `baseline` | configuration | BSL | — | 4 |
| `configuration_item` | configuration | CONF | configuration_item | 4 |
| `interface_contract` | configuration | INTF | interface_contract | 4 |
| `physical_binding` | configuration | BIND | physical_binding | 3 |
| `controlled_document` | qms | DOC | controlled_document | 6 |
| `authored_fragment` | qms | — | authored_fragment | 2 |
| `document_composition` | qms | — | — | 1 |
| `ml_promotion_decision` | qms | — | — | 1 |
| `nonconformity` | qms | QEV | nonconformity | 5 |
| `capa` | qms | QEV | capa | 6 |
| `supplier` | qms | SUP | supplier | 4 |
| `equipment` | qms | EQP | equipment | 4 |
| `complaint` | qms | CMP | complaint | 4 |
| `risk_control` | engineering | RCT | risk_control | 4 |
| `test_definition` | engineering | TSD | test_definition | 3 |
| `test_execution` | engineering | TSX | test_execution | 5 |
| `milestone` | project | MST | — | 4 |
| `work_order_amendment` | commercial | AMD | — | 3 |
| `warrant` | project | WAR | warrant | 7 |

## Relation types

| Relation | Inverse | Acyclic |
|---|---|---|
| `contains` | contained_by | yes |
| `decomposes_into` | part_of | yes |
| `affects` | affected_by |  |
| `authorizes` | authorized_by |  |
| `executes` | executed_by |  |
| `produces` | produced_by |  |
| `consumes` | consumed_by |  |
| `proposes` | proposed_by |  |
| `governs` | governed_by |  |
| `implements` | implemented_by |  |
| `satisfies` | satisfied_by |  |
| `verifies` | verified_by |  |
| `mitigates` | mitigated_by |  |
| `accepts` | accepted_by |  |
| `bills` | billed_by |  |
| `settles` | settled_by |  |
| `allocates_to` | allocated_from |  |
| `originated_from` | originated |  |
| `supersedes` | superseded_by | yes |
| `derived_from` | source_of |  |
| `evidences` | evidenced_by |  |
| `assigned_to` | assignee_of |  |
| `scoped_to` | scope_of |  |
| `depends_on` | dependency_of | yes |
| `blocks` | blocked_by |  |
| `released_by` | releases |  |
| `baseline_contains` | included_in_baseline |  |
| `performed_by` | performed |  |
| `owned_by` | owns |  |
| `linked_to` | linked_to |  |
| `amends` | amended_by | yes |
| `extends` | extended_by | yes |
| `generated_by` | generated |  |
| `used` | was_used_by |  |
| `was_associated_with` | associated_with |  |
| `conforms_to` | conformed_to_by |  |
| `bound_to` | binds |  |
| `supplied_by` | supplies |  |
| `calibrated_with` | calibrates |  |
| `raised_against` | raised |  |
| `remediated_by` | remediates |  |

## Actions

| Action | Drives | Requires |
|---|---|---|
| `create_initiative` | — | role only |
| `triage_initiative` | initiative_project | role only |
| `authorize_project` | initiative_project | act |
| `activate_project` | initiative_project | role only |
| `create_work_package` | work_package | role only |
| `start_work_package` | work_package | role only |
| `accept_work_package` | work_package | role only |
| `issue_work_order` | work_order | act |
| `accept_work_order` | work_order | role only |
| `amend_work_order` | — | role only |
| `submit_work_execution` | work_execution, work_package | role only |
| `review_work_execution` | work_execution, work_package | role only |
| `issue_acceptance` | work_execution, work_order | act |
| `propose_decision` | decision_record | role only |
| `accept_decision` | decision_record | act |
| `reject_decision` | decision_record | act |
| `supersede_decision` | decision_record | act |
| `open_change` | change_record | role only |
| `approve_change` | change_record | act |
| `verify_change` | change_record | role only |
| `make_change_effective` | change_record | act |
| `submit_invoice` | invoice | role only |
| `approve_invoice` | invoice | act |
| `authorize_payment` | payment | act |
| `record_payment_settlement` | invoice, payment | role only |
| `reconcile_payment` | payment | role only |
| `complete_project_technical` | initiative_project | role only |
| `close_project_administrative` | initiative_project | role only |
| `attach_evidence` | — | role only |
| `register_external_artifact` | — | role only |
| `correct_record` | capa, change_record, decision_record, initiative_project, invoice, payment, work_execution, work_order, work_package | role only |
| `promote_configuration_item` | configuration_item | role only |
| `supersede_configuration_item` | configuration_item | act |
| `retire_configuration_item` | configuration_item | role only |
| `publish_interface_contract` | interface_contract | act |
| `deprecate_interface_contract` | interface_contract | act |
| `withdraw_interface_contract` | interface_contract | role only |
| `record_physical_binding` | physical_binding | role only |
| `remove_physical_binding` | physical_binding | role only |
| `add_controlled_document` | — | role only |
| `submit_document_for_review` | controlled_document | role only |
| `approve_controlled_document` | controlled_document | act |
| `make_document_effective` | controlled_document | act |
| `supersede_controlled_document` | controlled_document | act |
| `withdraw_controlled_document` | controlled_document | role only |
| `add_authored_fragment` | — | role only |
| `revise_authored_fragment` | — | role only |
| `retire_authored_fragment` | authored_fragment | role only |
| `add_document_composition` | — | role only |
| `revise_document_composition` | — | role only |
| `change_document_source_holder` | — | role only |
| `request_document_compilation` | — | role only |
| `compile_master_record` | — | role only |
| `accept_document_compilation` | — | act |
| `publish_document_view` | — | act |
| `record_document_proposal` | — | role only |
| `apply_document_proposal` | — | role only |
| `release_person_entitlement_exclusion` | — | role only |
| `grant_person_clearance` | — | act |
| `grant_access` | — | act |
| `revoke_access` | — | act |
| `replicate_artifact_version` | — | role only |
| `verify_artifact_location` | — | role only |
| `allocate_enterprise_identifier` | — | act |
| `request_secure_object_access` | — | role only |
| `issue_secure_object_capability` | — | act |
| `revoke_secure_object_capability` | — | act |
| `consume_secure_object_capability` | — | role only |
| `request_secure_object_erasure` | — | role only |
| `record_secure_object_erasure` | — | act |
| `register_secure_object_authority_key` | — | act |
| `revoke_secure_object_authority_key` | — | act |
| `register_ml_aggregate_reference` | — | role only |
| `register_ml_run_lineage` | — | role only |
| `register_ml_metric_definition` | — | role only |
| `register_ml_metric_segment` | — | role only |
| `authorize_ml_metric_stream` | — | act |
| `append_ml_metric_event` | — | role only |
| `authorize_ml_promotion` | — | act |
| `raise_nonconformity` | — | role only |
| `contain_nonconformity` | nonconformity | role only |
| `investigate_nonconformity` | nonconformity | role only |
| `disposition_nonconformity` | nonconformity | role only |
| `close_nonconformity` | nonconformity | role only |
| `open_capa` | — | role only |
| `approve_capa_plan` | capa | act |
| `implement_capa` | capa | role only |
| `check_capa_effectiveness` | capa | role only |
| `close_capa` | capa | role only |
| `register_supplier` | — | role only |
| `qualify_supplier` | supplier | role only |
| `restrict_supplier` | supplier | role only |
| `disqualify_supplier` | supplier | act |
| `register_equipment` | — | role only |
| `place_equipment_in_service` | equipment | role only |
| `remove_equipment_from_service` | equipment | role only |
| `quarantine_equipment` | equipment | role only |
| `retire_equipment` | equipment | role only |
| `receive_complaint` | — | role only |
| `triage_complaint` | complaint | role only |
| `investigate_complaint` | complaint | role only |
| `close_complaint` | complaint | role only |
| `propose_risk_control` | — | role only |
| `implement_risk_control` | risk_control | role only |
| `verify_risk_control` | risk_control | role only |
| `retire_risk_control` | risk_control | role only |
| `define_test` | — | role only |
| `approve_test_definition` | test_definition | act |
| `supersede_test_definition` | test_definition | act |
| `plan_test_execution` | — | role only |
| `execute_test` | test_execution | role only |
| `record_test_result` | test_execution | role only |
| `invalidate_test_execution` | test_execution | act |
| `create_warrant_draft` | — | role only |
| `revise_warrant_draft` | — | role only |
| `submit_warrant` | warrant | role only |
| `authorize_warrant_contract` | warrant | act |
| `withdraw_warrant_proposal` | warrant | role only |
| `propose_warrant_amendment` | — | role only |
| `authorize_warrant_amendment` | warrant | act |
| `reject_warrant_amendment` | — | role only |
| `record_warrant_preflight` | warrant | role only |
| `authorize_warrant_dispatch` | warrant | act |
| `attach_warrant_runtime_receipt` | — | role only |
| `register_warrant_submission` | warrant | role only |
| `open_warrant_blocker` | — | role only |
| `resolve_warrant_blocker` | — | role only |
| `pause_warrant` | — | role only |
| `resume_warrant` | — | role only |
| `propose_warrant_deviation` | — | role only |
| `approve_warrant_deviation` | — | act |
| `reject_warrant_deviation` | — | role only |
| `record_warrant_discovered_gap` | — | role only |
| `register_warrant_artifact` | — | role only |
| `register_warrant_evidence` | — | role only |
| `attach_warrant_gate_run` | — | role only |
| `record_warrant_inference` | — | role only |
| `record_warrant_judgment` | — | role only |
| `request_warrant_resolution` | — | role only |
| `resolve_warrant` | warrant | act |
| `dispute_warrant_resolution` | — | role only |
| `resolve_warrant_dispute` | — | act |
| `annul_warrant_resolution` | — | act |
| `supersede_warrant` | — | act |
| `deprecate_warrant` | — | act |

## Lifecycles

### `initiative_project`

Initial: `captured` · Terminal: `administratively_closed`, `rejected`, `cancelled`

```mermaid
stateDiagram-v2
    [*] --> captured
    captured --> triage: triage_initiative
    triage --> evaluating: triage_initiative
    evaluating --> authorized: authorize_project
    authorized --> active: activate_project
    active --> technically_complete: complete_project_technical
    technically_complete --> administratively_closed: close_project_administrative
    captured --> parked: triage_initiative
    triage --> parked: triage_initiative
    parked --> triage: triage_initiative
    evaluating --> rejected: triage_initiative
    authorized --> cancelled: correct_record
    active --> cancelled: correct_record
    administratively_closed --> [*]
    rejected --> [*]
    cancelled --> [*]
```

### `work_package`

Initial: `planned` · Terminal: `accepted`, `waived`, `cancelled`

```mermaid
stateDiagram-v2
    [*] --> planned
    planned --> ready: create_work_package
    ready --> active: start_work_package
    active --> blocked: correct_record
    blocked --> active: correct_record
    active --> submitted: submit_work_execution
    submitted --> accepted: accept_work_package
    submitted --> active: review_work_execution
    planned --> cancelled: correct_record
    active --> waived: correct_record
    accepted --> [*]
    waived --> [*]
    cancelled --> [*]
```

### `work_order`

Initial: `draft` · Terminal: `closed`, `cancelled`, `terminated`

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> offered: issue_work_order
    offered --> accepted: accept_work_order
    accepted --> active: accept_work_order
    active --> suspended: correct_record
    suspended --> active: correct_record
    active --> completed: issue_acceptance
    completed --> closed: correct_record
    draft --> cancelled: correct_record
    offered --> cancelled: correct_record
    active --> terminated: correct_record
    closed --> [*]
    cancelled --> [*]
    terminated --> [*]
```

### `work_execution`

Initial: `draft` · Terminal: `accepted`, `partially_accepted`, `rejected`, `superseded`

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> submitted: submit_work_execution
    submitted --> under_review: review_work_execution
    under_review --> accepted: issue_acceptance
    under_review --> partially_accepted: issue_acceptance
    under_review --> rejected: issue_acceptance
    submitted --> superseded: correct_record
    accepted --> [*]
    partially_accepted --> [*]
    rejected --> [*]
    superseded --> [*]
```

### `decision_record`

Initial: `draft` · Terminal: `rejected`, `superseded`, `withdrawn`

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> proposed: propose_decision
    proposed --> accepted: accept_decision
    proposed --> rejected: reject_decision
    proposed --> withdrawn: correct_record
    accepted --> superseded: supersede_decision
    rejected --> [*]
    superseded --> [*]
    withdrawn --> [*]
```

### `change_record`

Initial: `proposed` · Terminal: `closed`, `rejected`

```mermaid
stateDiagram-v2
    [*] --> proposed
    proposed --> impact_assessment: open_change
    impact_assessment --> approved: approve_change
    impact_assessment --> rejected: approve_change
    approved --> implementing: approve_change
    implementing --> verified: verify_change
    verified --> effective: make_change_effective
    effective --> closed: correct_record
    closed --> [*]
    rejected --> [*]
```

### `invoice`

Initial: `draft` · Terminal: `paid`, `void`

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> submitted: submit_invoice
    submitted --> approved: approve_invoice
    submitted --> disputed: approve_invoice
    approved --> partially_paid: record_payment_settlement
    approved --> paid: record_payment_settlement
    partially_paid --> paid: record_payment_settlement
    draft --> void: correct_record
    disputed --> approved: approve_invoice
    disputed --> void: correct_record
    paid --> [*]
    void --> [*]
```

### `payment`

Initial: `planned` · Terminal: `reversed`, `failed`

```mermaid
stateDiagram-v2
    [*] --> planned
    planned --> authorized: authorize_payment
    authorized --> initiated: authorize_payment
    initiated --> settled: record_payment_settlement
    settled --> reconciled: reconcile_payment
    initiated --> failed: record_payment_settlement
    settled --> reversed: correct_record
    reconciled --> reversed: correct_record
    reversed --> [*]
    failed --> [*]
```

### `configuration_item`

Initial: `proposed` · Terminal: `retired`

```mermaid
stateDiagram-v2
    [*] --> proposed
    proposed --> active: promote_configuration_item
    active --> superseded: supersede_configuration_item
    superseded --> retired: retire_configuration_item
    active --> retired: retire_configuration_item
    proposed --> retired: retire_configuration_item
    retired --> [*]
```

### `interface_contract`

Initial: `draft` · Terminal: `withdrawn`

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> published: publish_interface_contract
    published --> deprecated: deprecate_interface_contract
    deprecated --> withdrawn: withdraw_interface_contract
    draft --> withdrawn: withdraw_interface_contract
    withdrawn --> [*]
```

### `physical_binding`

Initial: `planned` · Terminal: `removed`

```mermaid
stateDiagram-v2
    [*] --> planned
    planned --> installed: record_physical_binding
    installed --> removed: remove_physical_binding
    planned --> removed: remove_physical_binding
    removed --> [*]
```

### `controlled_document`

Initial: `draft` · Terminal: `withdrawn`

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> in_review: submit_document_for_review
    in_review --> approved: approve_controlled_document
    in_review --> draft: approve_controlled_document
    approved --> effective: make_document_effective
    effective --> superseded: supersede_controlled_document
    superseded --> withdrawn: withdraw_controlled_document
    draft --> withdrawn: withdraw_controlled_document
    withdrawn --> [*]
```

### `authored_fragment`

Initial: `active` · Terminal: `retired`

```mermaid
stateDiagram-v2
    [*] --> active
    active --> retired: retire_authored_fragment
    retired --> [*]
```

### `nonconformity`

Initial: `open` · Terminal: `closed`

```mermaid
stateDiagram-v2
    [*] --> open
    open --> contained: contain_nonconformity
    contained --> investigated: investigate_nonconformity
    investigated --> dispositioned: disposition_nonconformity
    dispositioned --> closed: close_nonconformity
    closed --> [*]
```

### `capa`

Initial: `open` · Terminal: `closed`, `cancelled`

```mermaid
stateDiagram-v2
    [*] --> open
    open --> plan_approved: approve_capa_plan
    plan_approved --> implementing: implement_capa
    implementing --> effectiveness_check: check_capa_effectiveness
    effectiveness_check --> closed: close_capa
    effectiveness_check --> implementing: check_capa_effectiveness
    open --> cancelled: correct_record
    closed --> [*]
    cancelled --> [*]
```

### `supplier`

Initial: `prospective` · Terminal: `disqualified`

```mermaid
stateDiagram-v2
    [*] --> prospective
    prospective --> qualified: qualify_supplier
    prospective --> conditional: qualify_supplier
    qualified --> conditional: restrict_supplier
    conditional --> qualified: qualify_supplier
    qualified --> disqualified: disqualify_supplier
    conditional --> disqualified: disqualify_supplier
    prospective --> disqualified: disqualify_supplier
    disqualified --> [*]
```

### `equipment`

Initial: `in_service` · Terminal: `retired`

```mermaid
stateDiagram-v2
    [*] --> in_service
    in_service --> out_of_service: remove_equipment_from_service
    out_of_service --> in_service: place_equipment_in_service
    in_service --> quarantined: quarantine_equipment
    quarantined --> in_service: place_equipment_in_service
    quarantined --> retired: retire_equipment
    out_of_service --> retired: retire_equipment
    retired --> [*]
```

### `complaint`

Initial: `received` · Terminal: `closed`

```mermaid
stateDiagram-v2
    [*] --> received
    received --> triaged: triage_complaint
    triaged --> investigated: investigate_complaint
    investigated --> closed: close_complaint
    triaged --> closed: close_complaint
    closed --> [*]
```

### `risk_control`

Initial: `proposed` · Terminal: `retired`

```mermaid
stateDiagram-v2
    [*] --> proposed
    proposed --> implemented: implement_risk_control
    implemented --> verified: verify_risk_control
    verified --> implemented: verify_risk_control
    verified --> retired: retire_risk_control
    proposed --> retired: retire_risk_control
    retired --> [*]
```

### `test_definition`

Initial: `draft` · Terminal: `superseded`

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> approved: approve_test_definition
    approved --> superseded: supersede_test_definition
    draft --> superseded: supersede_test_definition
    superseded --> [*]
```

### `test_execution`

Initial: `planned` · Terminal: `invalidated`

```mermaid
stateDiagram-v2
    [*] --> planned
    planned --> executed: execute_test
    executed --> passed: record_test_result
    executed --> failed: record_test_result
    passed --> invalidated: invalidate_test_execution
    failed --> invalidated: invalidate_test_execution
    executed --> invalidated: invalidate_test_execution
    invalidated --> [*]
```

### `warrant`

Initial: `draft` · Terminal: `resolved`

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> proposed: submit_warrant
    proposed --> draft: withdraw_warrant_proposal
    proposed --> authorized: authorize_warrant_contract
    authorized --> ready: record_warrant_preflight
    ready --> executing: authorize_warrant_dispatch
    executing --> verifying: register_warrant_submission
    verifying --> resolved: resolve_warrant
    ready --> authorized: authorize_warrant_amendment
    executing --> authorized: authorize_warrant_amendment
    verifying --> authorized: authorize_warrant_amendment
    resolved --> [*]
```

## Invariants

| Rule | Enforced at | Statement |
|---|---|---|
| `KF-GRAPH-001` | validator | Every edge source and target resolves to a node in the same graph view or a declared federated resource. |
| `KF-WORK-001` | database_constraint, validator | A work_execution references exactly one work_order. |
| `KF-WORK-002` | database_constraint, validator | A work_order references exactly one project and one engagement. |
| `KF-DEC-001` | action_precondition, validator | Accepted or rejected decision records are immutable; supersession creates a new decision record. |
| `KF-CHG-001` | action_precondition, validator | A change record implements, but never substitutes for, the decision rationale that authorized it. |
| `KF-FIN-001` | database_constraint, action_precondition, validator | Accepted value must not exceed authorized work-order ceiling without an approved amendment. |
| `KF-FIN-002` | database_constraint, action_precondition, validator | Invoice line value must not exceed accepted value available for the referenced work order. |
| `KF-FIN-003` | database_constraint, action_precondition, validator | Payment allocations must sum to no more than the payment amount and must not exceed invoice balances. |
| `KF-PROJ-001` | validator | Project progress is computed from accepted or waived work packages, not spending or activity count. |
| `KF-PROJ-002` | action_precondition, validator | Administrative project closure requires technical disposition plus closure of open work orders and financial obligations. |
| `KF-DOC-001` | database_constraint, action_precondition, validator | Every authored document subject has one current Source Holder and Holder changes use the narrow typed action. |
| `KF-DOC-002` | database_constraint, action_precondition, validator | A compilation run and its views must consume the exact Basis authorized by one prior compilation request action. |
| `KF-DOC-003` | database_constraint, action_precondition, validator | Each document subject has one immutable authoritative document policy that callers cannot weaken; Holder transfer, compilation acceptance and publication require scoped technical authority plus any quality authority required by that policy. |
| `KF-DOC-004` | database_constraint, action_precondition, validator | A Proposal Overlay is append-only; applying one requires a human-authorized typed action, an applied fragment remains a live draft, and no result is official before controlled review, effectivity and publication. |
| `KF-DOC-005` | database_constraint, action_precondition, validator | Every official document publication has one append-only receipt binding the exact accepted compiler result, effective controlled content revision and registered destination policy that authorized it. |

## Corpus projections

| Projection | Version | Traverse | Sections | Remainder |
|---|---|---|---|---|
| `master_sections` | 1 | person anchors ≤ 8 | `withdrawn` (withdrawn), `your_record` (reached), `org_view` (unreached) | `raw_corpus` |
| `raw_corpus` | 1 | — | — | `raw_corpus` |
| `agent_context` | 1 | person anchors ≤ 8 | `relevant` (reached), `organization` (unreached) | `raw_corpus` |
| `object_view` | 1 | all relations ≤ 1 | `subject` (anchor), `relationships` (reached) | `other` |
