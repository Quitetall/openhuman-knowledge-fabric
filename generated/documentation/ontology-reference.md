<!-- GENERATED from ontology/ — do not edit. -->
<!-- ontology_version: 1.0.0-draft.1 · source_digest: d1511f4416e03cb06dde92ceeade82bc060aed793cd9fbc674ced30f332e83ad -->

# Ontology reference

Compiled from `ontology/`. 21 object types, 34 relation types, 30 action types, 8 state machines, 10 invariants.

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
| `generated_by` | generated |  |
| `used` | was_used_by |  |
| `was_associated_with` | associated_with |  |

## Actions

| Action | Drives |
|---|---|
| `create_initiative` | — |
| `triage_initiative` | initiative_project |
| `authorize_project` | initiative_project |
| `activate_project` | initiative_project |
| `create_work_package` | work_package |
| `start_work_package` | work_package |
| `accept_work_package` | work_package |
| `issue_work_order` | work_order |
| `accept_work_order` | work_order |
| `amend_work_order` | — |
| `submit_work_execution` | work_execution, work_package |
| `review_work_execution` | work_execution, work_package |
| `issue_acceptance` | work_execution, work_order |
| `propose_decision` | decision_record |
| `accept_decision` | decision_record |
| `reject_decision` | decision_record |
| `supersede_decision` | decision_record |
| `open_change` | change_record |
| `approve_change` | change_record |
| `verify_change` | change_record |
| `make_change_effective` | change_record |
| `submit_invoice` | invoice |
| `approve_invoice` | invoice |
| `authorize_payment` | payment |
| `record_payment_settlement` | invoice, payment |
| `reconcile_payment` | payment |
| `complete_project_technical` | initiative_project |
| `close_project_administrative` | initiative_project |
| `attach_evidence` | — |
| `correct_record` | change_record, decision_record, initiative_project, invoice, payment, work_execution, work_order, work_package |

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
