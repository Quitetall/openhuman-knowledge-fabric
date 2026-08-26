-- migrate:up

-- Row-level security for the typed tables, stage one: quality, engineering, org, finance.
--
-- Decision 0003, option (a). `20260811000400_row_security.sql` put RLS on `core.object`,
-- `core.relation` and `core.audit_event` and stopped there, which left the envelope protected
-- and the substance open: a nonconformity's description and containment, a CAPA's root cause,
-- a work order's scope, a person's record. Measured before this migration, in one unbound
-- kf_readonly session:
--
--     core.object visible:               0
--     quality.controlled_document rows:  3
--     org.person rows:                   1
--
-- The application path was protected in practice, because its queries join `core.object` and
-- inherit those policies through the join. That is a property of how the queries happen to be
-- written, not one the database enforced — and kf_readonly and kf_auditor, which exist to
-- connect and read directly, had no protection even in practice.
--
-- THE PREDICATE. A typed row is visible exactly when the record it belongs to is. Two shapes:
--
--   envelope-keyed  the typed row IS an object (`id` references `core.object`), so the test
--                   is that its own envelope is visible. `core.object` FORCES row-level
--                   security, so this subquery is itself policy-filtered and the two axes —
--                   organization and classification ceiling — are inherited rather than
--                   restated. Restating them here would be a second copy to drift.
--
--   child           the row hangs off one or more parents (an invoice line, a payment
--                   allocation, a training record). It is visible when EVERY parent is, the
--                   same rule `core.relation` already applies to its two endpoints: otherwise
--                   the join table leaks the existence of records the reader may not see, and
--                   existence is often the sensitive part.
--
-- ENABLED, NOT FORCED. Unlike `core.object`, and unlike the append-only authority tables where
-- forcing is the point because every write must pass a trigger. Here the owner is a
-- maintenance path: `search.index_object` and `search.text_for` are SECURITY DEFINER and read
-- every one of these tables to assemble a record's searchable text. An indexer restricted to
-- rows it can itself see would build the subset index that `text_for`'s own comment rejects —
-- "an index that looks complete and is not".
--
-- kf_backup. Every one of these tables already grants it SELECT, and preservation is
-- deliberately cross-organization. Without an explicit policy the grant would survive while
-- silently returning nothing, which is a backup that looks complete and is not. Each table
-- therefore carries the same `to kf_backup using (true)` select policy the secure-object
-- ledger uses. kf_backup holds SELECT only; it cannot mint or alter a record.
--
-- NOT INCLUDED, and why:
--
--   org.role and quality.federated_source carry no organization anchor at all — they are
--   vocabulary, like `registry.*`. `org.role` is read by the role-assignment policies and by
--   every authority check; RLS on a table with nothing to scope by would deny everything and
--   protect nothing.
--
--   `registry.*` for the same reason and one stronger: `core.object`'s own policies read
--   `registry.classification` to rank a row. A policy that depends on a table that has a
--   policy that depends on it is not a boundary, it is a deadlock.
--
--   org.external_identity, which maps an issuer+subject to a person, is read by `resolveIn`
--   BEFORE the caller's organization claim has been verified: `resolveCaller` binds the
--   access context FROM the claim and then proves it. Scoping this table by that context
--   answers an authentication question with a scope answer — a valid token naming the wrong
--   organization stops reporting `role_not_held` and starts reporting `unknown_subject`, and
--   a person whose own record sits above the classification ceiling they requested cannot
--   sign in at all. Both were observed when it was included. It needs a scope that does not
--   come from the caller's own claim, or a narrower grant; either is its own change.
--
--   `core.action`, `core.approval`, `core.snapshot`, `core.outbox`, `ops.*`, `product.*`,
--   `work.*`, `content.*` — stage two. Decision 0003 committed to staging by domain and
--   measuring the read-path cost before completing the sweep.
--
-- UPDATE POLICIES. Fourteen tables carry one, and that list came from `has_column_privilege`,
-- not `has_table_privilege`. The first pass used the table-level check, which reports FALSE
-- for a role holding UPDATE on specific COLUMNS — as kf_app does on ten of these — so ten
-- tables silently lost their writes: `update … where id = $1` matched zero rows and raised
-- nothing at all, and five end-to-end quality scenarios failed on a null column rather than
-- on a permission error. A grant that is column-shaped is still a grant.


alter table engineering.risk_control enable row level security;
create policy risk_control_scoped_read on engineering.risk_control for select using (
    exists (select 1 from core.object envelope where envelope.id = risk_control.id)
  );
create policy risk_control_scoped_insert on engineering.risk_control for insert with check (
    exists (select 1 from core.object envelope where envelope.id = risk_control.id)
  );
create policy risk_control_scoped_update on engineering.risk_control for update
  using (
    exists (select 1 from core.object envelope where envelope.id = risk_control.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = risk_control.id)
  );
create policy risk_control_backup_read on engineering.risk_control for select to kf_backup using (true);

alter table engineering.test_definition enable row level security;
create policy test_definition_scoped_read on engineering.test_definition for select using (
    exists (select 1 from core.object envelope where envelope.id = test_definition.id)
  );
create policy test_definition_scoped_insert on engineering.test_definition for insert with check (
    exists (select 1 from core.object envelope where envelope.id = test_definition.id)
  );
create policy test_definition_backup_read on engineering.test_definition for select to kf_backup using (true);

alter table engineering.test_execution enable row level security;
create policy test_execution_scoped_read on engineering.test_execution for select using (
    exists (select 1 from core.object envelope where envelope.id = test_execution.id)
  );
create policy test_execution_scoped_insert on engineering.test_execution for insert with check (
    exists (select 1 from core.object envelope where envelope.id = test_execution.id)
  );
create policy test_execution_scoped_update on engineering.test_execution for update
  using (
    exists (select 1 from core.object envelope where envelope.id = test_execution.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = test_execution.id)
  );
create policy test_execution_backup_read on engineering.test_execution for select to kf_backup using (true);

alter table finance.invoice enable row level security;
create policy invoice_scoped_read on finance.invoice for select using (
    exists (select 1 from core.object envelope where envelope.id = invoice.id)
  );
create policy invoice_scoped_insert on finance.invoice for insert with check (
    exists (select 1 from core.object envelope where envelope.id = invoice.id)
  );
create policy invoice_backup_read on finance.invoice for select to kf_backup using (true);

alter table finance.payment enable row level security;
create policy payment_scoped_read on finance.payment for select using (
    exists (select 1 from core.object envelope where envelope.id = payment.id)
  );
create policy payment_scoped_insert on finance.payment for insert with check (
    exists (select 1 from core.object envelope where envelope.id = payment.id)
  );
create policy payment_backup_read on finance.payment for select to kf_backup using (true);

alter table org.engagement enable row level security;
create policy engagement_scoped_read on org.engagement for select using (
    exists (select 1 from core.object envelope where envelope.id = engagement.id)
  );
create policy engagement_scoped_insert on org.engagement for insert with check (
    exists (select 1 from core.object envelope where envelope.id = engagement.id)
  );
create policy engagement_scoped_update on org.engagement for update
  using (
    exists (select 1 from core.object envelope where envelope.id = engagement.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = engagement.id)
  );
create policy engagement_backup_read on org.engagement for select to kf_backup using (true);

alter table org.organization enable row level security;
create policy organization_scoped_read on org.organization for select using (
    exists (select 1 from core.object envelope where envelope.id = organization.id)
  );
create policy organization_scoped_insert on org.organization for insert with check (
    exists (select 1 from core.object envelope where envelope.id = organization.id)
  );
create policy organization_scoped_update on org.organization for update
  using (
    exists (select 1 from core.object envelope where envelope.id = organization.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = organization.id)
  );
create policy organization_backup_read on org.organization for select to kf_backup using (true);

alter table org.person enable row level security;
create policy person_scoped_read on org.person for select using (
    exists (select 1 from core.object envelope where envelope.id = person.id)
  );
create policy person_scoped_insert on org.person for insert with check (
    exists (select 1 from core.object envelope where envelope.id = person.id)
  );
create policy person_scoped_update on org.person for update
  using (
    exists (select 1 from core.object envelope where envelope.id = person.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = person.id)
  );
create policy person_backup_read on org.person for select to kf_backup using (true);

alter table org.role_assignment enable row level security;
create policy role_assignment_scoped_read on org.role_assignment for select using (
    exists (select 1 from core.object envelope where envelope.id = role_assignment.id)
  );
create policy role_assignment_scoped_insert on org.role_assignment for insert with check (
    exists (select 1 from core.object envelope where envelope.id = role_assignment.id)
  );
create policy role_assignment_scoped_update on org.role_assignment for update
  using (
    exists (select 1 from core.object envelope where envelope.id = role_assignment.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = role_assignment.id)
  );
create policy role_assignment_backup_read on org.role_assignment for select to kf_backup using (true);

alter table quality.capa enable row level security;
create policy capa_scoped_read on quality.capa for select using (
    exists (select 1 from core.object envelope where envelope.id = capa.id)
  );
create policy capa_scoped_insert on quality.capa for insert with check (
    exists (select 1 from core.object envelope where envelope.id = capa.id)
  );
create policy capa_scoped_update on quality.capa for update
  using (
    exists (select 1 from core.object envelope where envelope.id = capa.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = capa.id)
  );
create policy capa_backup_read on quality.capa for select to kf_backup using (true);

alter table quality.complaint enable row level security;
create policy complaint_scoped_read on quality.complaint for select using (
    exists (select 1 from core.object envelope where envelope.id = complaint.id)
  );
create policy complaint_scoped_insert on quality.complaint for insert with check (
    exists (select 1 from core.object envelope where envelope.id = complaint.id)
  );
create policy complaint_scoped_update on quality.complaint for update
  using (
    exists (select 1 from core.object envelope where envelope.id = complaint.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = complaint.id)
  );
create policy complaint_backup_read on quality.complaint for select to kf_backup using (true);

alter table quality.controlled_document enable row level security;
create policy controlled_document_scoped_read on quality.controlled_document for select using (
    exists (select 1 from core.object envelope where envelope.id = controlled_document.id)
  );
create policy controlled_document_scoped_insert on quality.controlled_document for insert with check (
    exists (select 1 from core.object envelope where envelope.id = controlled_document.id)
  );
create policy controlled_document_scoped_update on quality.controlled_document for update
  using (
    exists (select 1 from core.object envelope where envelope.id = controlled_document.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = controlled_document.id)
  );
create policy controlled_document_backup_read on quality.controlled_document for select to kf_backup using (true);

alter table quality.equipment enable row level security;
create policy equipment_scoped_read on quality.equipment for select using (
    exists (select 1 from core.object envelope where envelope.id = equipment.id)
  );
create policy equipment_scoped_insert on quality.equipment for insert with check (
    exists (select 1 from core.object envelope where envelope.id = equipment.id)
  );
create policy equipment_scoped_update on quality.equipment for update
  using (
    exists (select 1 from core.object envelope where envelope.id = equipment.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = equipment.id)
  );
create policy equipment_backup_read on quality.equipment for select to kf_backup using (true);

alter table quality.nonconformity enable row level security;
create policy nonconformity_scoped_read on quality.nonconformity for select using (
    exists (select 1 from core.object envelope where envelope.id = nonconformity.id)
  );
create policy nonconformity_scoped_insert on quality.nonconformity for insert with check (
    exists (select 1 from core.object envelope where envelope.id = nonconformity.id)
  );
create policy nonconformity_scoped_update on quality.nonconformity for update
  using (
    exists (select 1 from core.object envelope where envelope.id = nonconformity.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = nonconformity.id)
  );
create policy nonconformity_backup_read on quality.nonconformity for select to kf_backup using (true);

alter table quality.supplier enable row level security;
create policy supplier_scoped_read on quality.supplier for select using (
    exists (select 1 from core.object envelope where envelope.id = supplier.id)
  );
create policy supplier_scoped_insert on quality.supplier for insert with check (
    exists (select 1 from core.object envelope where envelope.id = supplier.id)
  );
create policy supplier_scoped_update on quality.supplier for update
  using (
    exists (select 1 from core.object envelope where envelope.id = supplier.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = supplier.id)
  );
create policy supplier_backup_read on quality.supplier for select to kf_backup using (true);

alter table engineering.change_item enable row level security;
create policy change_item_scoped_read on engineering.change_item for select using (
    exists (select 1 from core.object envelope where envelope.id = change_item.change_id)
    and exists (select 1 from core.object envelope where envelope.id = change_item.subject_id)
  );
create policy change_item_scoped_insert on engineering.change_item for insert with check (
    exists (select 1 from core.object envelope where envelope.id = change_item.change_id)
    and exists (select 1 from core.object envelope where envelope.id = change_item.subject_id)
  );
create policy change_item_backup_read on engineering.change_item for select to kf_backup using (true);

alter table engineering.decision_alternative enable row level security;
create policy decision_alternative_scoped_read on engineering.decision_alternative for select using (
    exists (select 1 from core.object envelope where envelope.id = decision_alternative.decision_id)
  );
create policy decision_alternative_scoped_insert on engineering.decision_alternative for insert with check (
    exists (select 1 from core.object envelope where envelope.id = decision_alternative.decision_id)
  );
create policy decision_alternative_backup_read on engineering.decision_alternative for select to kf_backup using (true);

alter table engineering.test_execution_equipment enable row level security;
create policy test_execution_equipment_scoped_read on engineering.test_execution_equipment for select using (
    exists (select 1 from engineering.test_execution parent
             where parent.id = test_execution_equipment.execution_id)
  );
create policy test_execution_equipment_scoped_insert on engineering.test_execution_equipment for insert with check (
    exists (select 1 from engineering.test_execution parent
             where parent.id = test_execution_equipment.execution_id)
  );
create policy test_execution_equipment_backup_read on engineering.test_execution_equipment for select to kf_backup using (true);

alter table engineering.verification_link enable row level security;
create policy verification_link_scoped_read on engineering.verification_link for select using (
    exists (select 1 from engineering.test_execution parent
             where parent.id = verification_link.execution_id)
    and exists (select 1 from core.object envelope where envelope.id = verification_link.subject_id)
  );
create policy verification_link_scoped_insert on engineering.verification_link for insert with check (
    exists (select 1 from engineering.test_execution parent
             where parent.id = verification_link.execution_id)
    and exists (select 1 from core.object envelope where envelope.id = verification_link.subject_id)
  );
create policy verification_link_backup_read on engineering.verification_link for select to kf_backup using (true);

alter table finance.invoice_line enable row level security;
create policy invoice_line_scoped_read on finance.invoice_line for select using (
    exists (select 1 from finance.invoice parent where parent.id = invoice_line.invoice_id)
  );
create policy invoice_line_scoped_insert on finance.invoice_line for insert with check (
    exists (select 1 from finance.invoice parent where parent.id = invoice_line.invoice_id)
  );
create policy invoice_line_backup_read on finance.invoice_line for select to kf_backup using (true);

alter table finance.payment_allocation enable row level security;
create policy payment_allocation_scoped_read on finance.payment_allocation for select using (
    exists (select 1 from finance.invoice parent where parent.id = payment_allocation.invoice_id)
    and exists (select 1 from finance.payment parent where parent.id = payment_allocation.payment_id)
  );
create policy payment_allocation_scoped_insert on finance.payment_allocation for insert with check (
    exists (select 1 from finance.invoice parent where parent.id = payment_allocation.invoice_id)
    and exists (select 1 from finance.payment parent where parent.id = payment_allocation.payment_id)
  );
create policy payment_allocation_backup_read on finance.payment_allocation for select to kf_backup using (true);

alter table org.project_membership enable row level security;
create policy project_membership_scoped_read on org.project_membership for select using (
    exists (select 1 from org.person parent where parent.id = project_membership.person_id)
    and exists (select 1 from core.object envelope where envelope.id = project_membership.project_id)
  );
create policy project_membership_scoped_insert on org.project_membership for insert with check (
    exists (select 1 from org.person parent where parent.id = project_membership.person_id)
    and exists (select 1 from core.object envelope where envelope.id = project_membership.project_id)
  );
create policy project_membership_scoped_update on org.project_membership for update
  using (
    exists (select 1 from org.person parent where parent.id = project_membership.person_id)
    and exists (select 1 from core.object envelope where envelope.id = project_membership.project_id)
  )
  with check (
    exists (select 1 from org.person parent where parent.id = project_membership.person_id)
    and exists (select 1 from core.object envelope where envelope.id = project_membership.project_id)
  );
create policy project_membership_backup_read on org.project_membership for select to kf_backup using (true);

alter table quality.calibration enable row level security;
create policy calibration_scoped_read on quality.calibration for select using (
    exists (select 1 from quality.equipment parent where parent.id = calibration.equipment_id)
  );
create policy calibration_scoped_insert on quality.calibration for insert with check (
    exists (select 1 from quality.equipment parent where parent.id = calibration.equipment_id)
  );
create policy calibration_backup_read on quality.calibration for select to kf_backup using (true);

alter table quality.capa_nonconformity enable row level security;
create policy capa_nonconformity_scoped_read on quality.capa_nonconformity for select using (
    exists (select 1 from quality.capa parent where parent.id = capa_nonconformity.capa_id)
    and exists (select 1 from quality.nonconformity parent
                 where parent.id = capa_nonconformity.nonconformity_id)
  );
create policy capa_nonconformity_scoped_insert on quality.capa_nonconformity for insert with check (
    exists (select 1 from quality.capa parent where parent.id = capa_nonconformity.capa_id)
    and exists (select 1 from quality.nonconformity parent
                 where parent.id = capa_nonconformity.nonconformity_id)
  );
create policy capa_nonconformity_backup_read on quality.capa_nonconformity for select to kf_backup using (true);

alter table quality.federated_link enable row level security;
create policy federated_link_scoped_read on quality.federated_link for select using (
    exists (select 1 from core.object envelope where envelope.id = federated_link.object_id)
    and exists (select 1 from quality.federated_reference parent
                 where parent.id = federated_link.reference_id)
  );
create policy federated_link_scoped_insert on quality.federated_link for insert with check (
    exists (select 1 from core.object envelope where envelope.id = federated_link.object_id)
    and exists (select 1 from quality.federated_reference parent
                 where parent.id = federated_link.reference_id)
  );
create policy federated_link_backup_read on quality.federated_link for select to kf_backup using (true);

alter table quality.federated_reference enable row level security;
create policy federated_reference_scoped_read on quality.federated_reference for select using (
    exists (select 1 from core.object envelope where envelope.id = federated_reference.recorded_by)
  );
create policy federated_reference_scoped_insert on quality.federated_reference for insert with check (
    exists (select 1 from core.object envelope where envelope.id = federated_reference.recorded_by)
  );
create policy federated_reference_scoped_update on quality.federated_reference for update
  using (
    exists (select 1 from core.object envelope where envelope.id = federated_reference.recorded_by)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = federated_reference.recorded_by)
  );
create policy federated_reference_backup_read on quality.federated_reference for select to kf_backup using (true);

alter table quality.supplier_qualification enable row level security;
create policy supplier_qualification_scoped_read on quality.supplier_qualification for select using (
    exists (select 1 from quality.supplier parent
             where parent.id = supplier_qualification.supplier_id)
  );
create policy supplier_qualification_scoped_insert on quality.supplier_qualification for insert with check (
    exists (select 1 from quality.supplier parent
             where parent.id = supplier_qualification.supplier_id)
  );
create policy supplier_qualification_backup_read on quality.supplier_qualification for select to kf_backup using (true);

alter table quality.training_record enable row level security;
create policy training_record_scoped_read on quality.training_record for select using (
    exists (select 1 from org.person parent where parent.id = training_record.person_id)
    and exists (select 1 from quality.controlled_document parent
                 where parent.id = training_record.document_id)
  );
create policy training_record_scoped_insert on quality.training_record for insert with check (
    exists (select 1 from org.person parent where parent.id = training_record.person_id)
    and exists (select 1 from quality.controlled_document parent
                 where parent.id = training_record.document_id)
  );
create policy training_record_backup_read on quality.training_record for select to kf_backup using (true);

alter table quality.training_requirement enable row level security;
create policy training_requirement_scoped_read on quality.training_requirement for select using (
    exists (select 1 from quality.controlled_document parent
             where parent.id = training_requirement.document_id)
  );
create policy training_requirement_scoped_insert on quality.training_requirement for insert with check (
    exists (select 1 from quality.controlled_document parent
             where parent.id = training_requirement.document_id)
  );
create policy training_requirement_backup_read on quality.training_requirement for select to kf_backup using (true);

-- migrate:down
-- kf:forward-only reverting would return 29 tables holding the substance of every record to unrestricted reads

-- Forward-only. Reverting would return 29 tables holding the substance of every record to
-- unrestricted reads by any role that can connect.
