-- migrate:up

-- Row-level security for the typed tables, stage two: core, content, product, work.
--
-- Decision 0003 option (a), completing what `20260816000300` started. Stage one took the
-- count of readable tables with no policies from 77 to 47. This takes it to 19, and every
-- one of those 19 is excluded on purpose, listed below with the reason.
--
-- THE ONE THAT MATTERS MOST is `core.action`. It carries `parameters` — the exact typed
-- payload of every action ever performed — which is where a record's substance lives before
-- and often instead of reaching a typed row. A nonconformity's description exists in
-- `quality.nonconformity` because an action put it there, and that action still holds it.
-- Protecting the typed tables while leaving the actions that wrote them open would have been
-- a boundary around the copy and not the original.
--
-- `core.action` is scoped by its own `organization_id` rather than through an envelope,
-- because it has one and because an action targets an ARRAY of objects — deriving
-- classification from `target_ids` would mean picking one target's ceiling to stand for all
-- of them, which is a decision the schema does not support and this migration should not
-- invent. Organization is exact; classification for actions is left to the objects they name.
--
-- THE AUDITOR CARVE-OUT, and it is a judgement worth overturning if you disagree.
-- `20260811000400` gave kf_auditor an unconditional read on `core.audit_event`, reasoning
-- that "an audit log you cannot read for your own records is useless; one you can read for
-- everyone else's is a leak" and choosing the first horn. `core.action` and `core.approval`
-- are the two tables that make an audit event interpretable — the event says what happened,
-- the action says what was asked and the approval says who agreed. An auditor who can read
-- every event but only one organization's actions has a trail that stops mid-sentence. So
-- those two follow the same precedent and no others do: `core.snapshot` holds copied record
-- content, `core.outbox` and `core.retention_hold` are operational, and all of them stay
-- scoped.
--
-- EXCLUDED, with reasons rather than silence:
--
--   registry.* (10 tables) — vocabulary. `core.object`'s own policies read
--   `registry.classification` to rank a row, so a policy on it would be a cycle: a boundary
--   that depends on a table whose boundary depends on it is not a boundary.
--
--   org.role and quality.federated_source — vocabulary, no organization anchor. Carried
--   forward from stage one.
--
--   ops.* (6 tables: backup_run, backup_copy, restore_drill, recovery_objective,
--   encrypted_backup_evidence, physical_failure_domain_evidence) — deployment facts, not
--   organization records. A backup run covers the whole cluster; asking which organization
--   owns a backup of everything has no answer. The `approved_by` and `declared_by` columns
--   are attribution, not ownership, and scoping a cluster-wide fact by whoever signed it off
--   would be a boundary that means something other than what it says.
--
--   core.audit_checkpoint — the signed Merkle checkpoint over the whole audit log. Global by
--   construction, no organization column, and the integrity spine auditors verify against.
--
--   org.external_identity — closed in the migration that follows this one, by withdrawing the
--   direct grant rather than by a policy. It is read before the caller's organization claim
--   has been verified, so a policy keyed on that claim answers an authentication question
--   with a scope answer.
--
-- Enabled, NOT forced, and each table keeps a `to kf_backup using (true)` select policy — the
-- same two decisions as stage one, for the same two reasons: the owner is the maintenance
-- path that the search indexer runs as, and every one of these tables already grants kf_backup
-- SELECT, so a policy-less grant would return nothing and produce a backup that looks
-- complete and is not.
--
-- UPDATE policies come from `has_column_privilege`, not `has_table_privilege`. That
-- distinction cost stage one five failing end-to-end scenarios and a silent write that
-- matched zero rows and raised nothing; five tables here hold column-level UPDATE grants and
-- would have done the same.


alter table core.action enable row level security;
create policy action_scoped_read on core.action for select using (
    action.organization_id = core.current_organization()
  );
create policy action_scoped_insert on core.action for insert with check (
    action.organization_id = core.current_organization()
  );
create policy action_auditor_read on core.action for select to kf_auditor using (true);
create policy action_backup_read on core.action for select to kf_backup using (true);

alter table core.approval enable row level security;
create policy approval_scoped_read on core.approval for select using (
    exists (select 1 from core.object envelope where envelope.id = approval.object_id)
  );
create policy approval_scoped_insert on core.approval for insert with check (
    exists (select 1 from core.object envelope where envelope.id = approval.object_id)
  );
create policy approval_auditor_read on core.approval for select to kf_auditor using (true);
create policy approval_backup_read on core.approval for select to kf_backup using (true);

alter table core.snapshot enable row level security;
create policy snapshot_scoped_read on core.snapshot for select using (
    exists (select 1 from core.object envelope where envelope.id = snapshot.object_id)
  );
create policy snapshot_scoped_insert on core.snapshot for insert with check (
    exists (select 1 from core.object envelope where envelope.id = snapshot.object_id)
  );
create policy snapshot_backup_read on core.snapshot for select to kf_backup using (true);

alter table core.retention_hold enable row level security;
create policy retention_hold_scoped_read on core.retention_hold for select using (
    exists (select 1 from core.object envelope where envelope.id = retention_hold.object_id)
  );
create policy retention_hold_scoped_insert on core.retention_hold for insert with check (
    exists (select 1 from core.object envelope where envelope.id = retention_hold.object_id)
  );
create policy retention_hold_backup_read on core.retention_hold for select to kf_backup using (true);

alter table core.outbox enable row level security;
create policy outbox_scoped_read on core.outbox for select using (
    exists (select 1 from core.action parent where parent.id = outbox.action_id)
  );
create policy outbox_scoped_insert on core.outbox for insert with check (
    exists (select 1 from core.action parent where parent.id = outbox.action_id)
  );
create policy outbox_scoped_update on core.outbox for update
  using (
    exists (select 1 from core.action parent where parent.id = outbox.action_id)
  )
  with check (
    exists (select 1 from core.action parent where parent.id = outbox.action_id)
  );
create policy outbox_backup_read on core.outbox for select to kf_backup using (true);

alter table content.artifact enable row level security;
create policy artifact_scoped_read on content.artifact for select using (
    exists (select 1 from core.object envelope where envelope.id = artifact.id)
  );
create policy artifact_scoped_insert on content.artifact for insert with check (
    exists (select 1 from core.object envelope where envelope.id = artifact.id)
  );
create policy artifact_scoped_update on content.artifact for update
  using (
    exists (select 1 from core.object envelope where envelope.id = artifact.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = artifact.id)
  );
create policy artifact_backup_read on content.artifact for select to kf_backup using (true);

alter table content.artifact_version enable row level security;
create policy artifact_version_scoped_read on content.artifact_version for select using (
    exists (select 1 from content.artifact parent where parent.id = artifact_version.artifact_id)
  );
create policy artifact_version_scoped_insert on content.artifact_version for insert with check (
    exists (select 1 from content.artifact parent where parent.id = artifact_version.artifact_id)
  );
create policy artifact_version_backup_read on content.artifact_version for select to kf_backup using (true);

alter table content.artifact_relationship enable row level security;
create policy artifact_relationship_scoped_read on content.artifact_relationship for select using (
    exists (select 1 from content.artifact_version source where source.id = artifact_relationship.from_version)
    and exists (select 1 from content.artifact_version target where target.id = artifact_relationship.to_version)
  );
create policy artifact_relationship_scoped_insert on content.artifact_relationship for insert with check (
    exists (select 1 from content.artifact_version source where source.id = artifact_relationship.from_version)
    and exists (select 1 from content.artifact_version target where target.id = artifact_relationship.to_version)
  );
create policy artifact_relationship_backup_read on content.artifact_relationship for select to kf_backup using (true);

alter table content.external_locator enable row level security;
create policy external_locator_scoped_read on content.external_locator for select using (
    exists (select 1 from content.artifact_version parent where parent.id = external_locator.version_id)
  );
create policy external_locator_scoped_insert on content.external_locator for insert with check (
    exists (select 1 from content.artifact_version parent where parent.id = external_locator.version_id)
  );
create policy external_locator_backup_read on content.external_locator for select to kf_backup using (true);

alter table product.configuration_item enable row level security;
create policy configuration_item_scoped_read on product.configuration_item for select using (
    exists (select 1 from core.object envelope where envelope.id = configuration_item.id)
  );
create policy configuration_item_scoped_insert on product.configuration_item for insert with check (
    exists (select 1 from core.object envelope where envelope.id = configuration_item.id)
  );
create policy configuration_item_backup_read on product.configuration_item for select to kf_backup using (true);

alter table product.interface_contract enable row level security;
create policy interface_contract_scoped_read on product.interface_contract for select using (
    exists (select 1 from core.object envelope where envelope.id = interface_contract.id)
  );
create policy interface_contract_scoped_insert on product.interface_contract for insert with check (
    exists (select 1 from core.object envelope where envelope.id = interface_contract.id)
  );
create policy interface_contract_backup_read on product.interface_contract for select to kf_backup using (true);

alter table product.physical_binding enable row level security;
create policy physical_binding_scoped_read on product.physical_binding for select using (
    exists (select 1 from core.object envelope where envelope.id = physical_binding.id)
  );
create policy physical_binding_scoped_insert on product.physical_binding for insert with check (
    exists (select 1 from core.object envelope where envelope.id = physical_binding.id)
  );
create policy physical_binding_scoped_update on product.physical_binding for update
  using (
    exists (select 1 from core.object envelope where envelope.id = physical_binding.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = physical_binding.id)
  );
create policy physical_binding_backup_read on product.physical_binding for select to kf_backup using (true);

alter table product.baseline_item enable row level security;
create policy baseline_item_scoped_read on product.baseline_item for select using (
    exists (select 1 from core.object envelope where envelope.id = baseline_item.baseline_id)
    and exists (select 1 from product.configuration_item item where item.id = baseline_item.configuration_item)
  );
create policy baseline_item_scoped_insert on product.baseline_item for insert with check (
    exists (select 1 from core.object envelope where envelope.id = baseline_item.baseline_id)
    and exists (select 1 from product.configuration_item item where item.id = baseline_item.configuration_item)
  );
create policy baseline_item_backup_read on product.baseline_item for select to kf_backup using (true);

alter table product.effectivity enable row level security;
create policy effectivity_scoped_read on product.effectivity for select using (
    exists (select 1 from core.object envelope where envelope.id = effectivity.subject_id)
  );
create policy effectivity_scoped_insert on product.effectivity for insert with check (
    exists (select 1 from core.object envelope where envelope.id = effectivity.subject_id)
  );
create policy effectivity_backup_read on product.effectivity for select to kf_backup using (true);

alter table product.interface_conformance enable row level security;
create policy interface_conformance_scoped_read on product.interface_conformance for select using (
    exists (select 1 from product.configuration_item item where item.id = interface_conformance.configuration_item)
    and exists (select 1 from product.interface_contract contract where contract.id = interface_conformance.interface_contract)
  );
create policy interface_conformance_scoped_insert on product.interface_conformance for insert with check (
    exists (select 1 from product.configuration_item item where item.id = interface_conformance.configuration_item)
    and exists (select 1 from product.interface_contract contract where contract.id = interface_conformance.interface_contract)
  );
create policy interface_conformance_backup_read on product.interface_conformance for select to kf_backup using (true);

alter table product.release_item enable row level security;
create policy release_item_scoped_read on product.release_item for select using (
    exists (select 1 from core.object envelope where envelope.id = release_item.release_id)
    and exists (select 1 from product.configuration_item item where item.id = release_item.configuration_item)
  );
create policy release_item_scoped_insert on product.release_item for insert with check (
    exists (select 1 from core.object envelope where envelope.id = release_item.release_id)
    and exists (select 1 from product.configuration_item item where item.id = release_item.configuration_item)
  );
create policy release_item_backup_read on product.release_item for select to kf_backup using (true);

alter table work.initiative_project enable row level security;
create policy initiative_project_scoped_read on work.initiative_project for select using (
    exists (select 1 from core.object envelope where envelope.id = initiative_project.id)
  );
create policy initiative_project_scoped_insert on work.initiative_project for insert with check (
    exists (select 1 from core.object envelope where envelope.id = initiative_project.id)
  );
create policy initiative_project_scoped_update on work.initiative_project for update
  using (
    exists (select 1 from core.object envelope where envelope.id = initiative_project.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = initiative_project.id)
  );
create policy initiative_project_backup_read on work.initiative_project for select to kf_backup using (true);

alter table work.work_package enable row level security;
create policy work_package_scoped_read on work.work_package for select using (
    exists (select 1 from core.object envelope where envelope.id = work_package.id)
  );
create policy work_package_scoped_insert on work.work_package for insert with check (
    exists (select 1 from core.object envelope where envelope.id = work_package.id)
  );
create policy work_package_backup_read on work.work_package for select to kf_backup using (true);

alter table work.work_order enable row level security;
create policy work_order_scoped_read on work.work_order for select using (
    exists (select 1 from core.object envelope where envelope.id = work_order.id)
  );
create policy work_order_scoped_insert on work.work_order for insert with check (
    exists (select 1 from core.object envelope where envelope.id = work_order.id)
  );
create policy work_order_backup_read on work.work_order for select to kf_backup using (true);

alter table work.work_execution enable row level security;
create policy work_execution_scoped_read on work.work_execution for select using (
    exists (select 1 from core.object envelope where envelope.id = work_execution.id)
  );
create policy work_execution_scoped_insert on work.work_execution for insert with check (
    exists (select 1 from core.object envelope where envelope.id = work_execution.id)
  );
create policy work_execution_backup_read on work.work_execution for select to kf_backup using (true);

alter table work.acceptance_record enable row level security;
create policy acceptance_record_scoped_read on work.acceptance_record for select using (
    exists (select 1 from core.object envelope where envelope.id = acceptance_record.id)
  );
create policy acceptance_record_scoped_insert on work.acceptance_record for insert with check (
    exists (select 1 from core.object envelope where envelope.id = acceptance_record.id)
  );
create policy acceptance_record_backup_read on work.acceptance_record for select to kf_backup using (true);

alter table work.deliverable enable row level security;
create policy deliverable_scoped_read on work.deliverable for select using (
    exists (select 1 from core.object envelope where envelope.id = deliverable.id)
  );
create policy deliverable_scoped_insert on work.deliverable for insert with check (
    exists (select 1 from core.object envelope where envelope.id = deliverable.id)
  );
create policy deliverable_backup_read on work.deliverable for select to kf_backup using (true);

alter table work.milestone enable row level security;
create policy milestone_scoped_read on work.milestone for select using (
    exists (select 1 from core.object envelope where envelope.id = milestone.id)
  );
create policy milestone_scoped_insert on work.milestone for insert with check (
    exists (select 1 from core.object envelope where envelope.id = milestone.id)
  );
create policy milestone_scoped_update on work.milestone for update
  using (
    exists (select 1 from core.object envelope where envelope.id = milestone.id)
  )
  with check (
    exists (select 1 from core.object envelope where envelope.id = milestone.id)
  );
create policy milestone_backup_read on work.milestone for select to kf_backup using (true);

alter table work.work_order_amendment enable row level security;
create policy work_order_amendment_scoped_read on work.work_order_amendment for select using (
    exists (select 1 from core.object envelope where envelope.id = work_order_amendment.id)
  );
create policy work_order_amendment_scoped_insert on work.work_order_amendment for insert with check (
    exists (select 1 from core.object envelope where envelope.id = work_order_amendment.id)
  );
create policy work_order_amendment_backup_read on work.work_order_amendment for select to kf_backup using (true);

alter table work.acceptance_item enable row level security;
create policy acceptance_item_scoped_read on work.acceptance_item for select using (
    exists (select 1 from work.acceptance_record record where record.id = acceptance_item.acceptance_id)
    and exists (select 1 from work.deliverable item where item.id = acceptance_item.deliverable_id)
  );
create policy acceptance_item_scoped_insert on work.acceptance_item for insert with check (
    exists (select 1 from work.acceptance_record record where record.id = acceptance_item.acceptance_id)
    and exists (select 1 from work.deliverable item where item.id = acceptance_item.deliverable_id)
  );
create policy acceptance_item_backup_read on work.acceptance_item for select to kf_backup using (true);

alter table work.deliverable_submission enable row level security;
create policy deliverable_submission_scoped_read on work.deliverable_submission for select using (
    exists (select 1 from work.deliverable item where item.id = deliverable_submission.deliverable_id)
    and exists (select 1 from work.work_execution execution where execution.id = deliverable_submission.work_execution_id)
  );
create policy deliverable_submission_scoped_insert on work.deliverable_submission for insert with check (
    exists (select 1 from work.deliverable item where item.id = deliverable_submission.deliverable_id)
    and exists (select 1 from work.work_execution execution where execution.id = deliverable_submission.work_execution_id)
  );
create policy deliverable_submission_backup_read on work.deliverable_submission for select to kf_backup using (true);

alter table work.project_event enable row level security;
create policy project_event_scoped_read on work.project_event for select using (
    exists (select 1 from work.initiative_project project where project.id = project_event.project_id)
  );
create policy project_event_scoped_insert on work.project_event for insert with check (
    exists (select 1 from work.initiative_project project where project.id = project_event.project_id)
  );
create policy project_event_backup_read on work.project_event for select to kf_backup using (true);

alter table work.work_order_scope enable row level security;
create policy work_order_scope_scoped_read on work.work_order_scope for select using (
    exists (select 1 from work.work_order order_row where order_row.id = work_order_scope.work_order_id)
    and exists (select 1 from work.work_package package where package.id = work_order_scope.work_package_id)
  );
create policy work_order_scope_scoped_insert on work.work_order_scope for insert with check (
    exists (select 1 from work.work_order order_row where order_row.id = work_order_scope.work_order_id)
    and exists (select 1 from work.work_package package where package.id = work_order_scope.work_package_id)
  );
create policy work_order_scope_backup_read on work.work_order_scope for select to kf_backup using (true);

-- migrate:down
-- kf:forward-only reverting would return 28 tables including every action’s exact parameters to unrestricted reads

-- Forward-only. Reverting would return 28 tables — including every action's exact parameters
-- — to unrestricted reads by any role that can connect.
