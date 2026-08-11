-- migrate:up

-- Rewrite `engineering.verification_status`. The first version over-claimed, twice.
--
-- It counted a `passed` execution whether or not anything was ever executed: nothing forces
-- `executed_on` to be set, so a row could reach `passed` with no execution behind it and the
-- subject would read as verified.
--
-- And it declared `verified` from the executions that happened to be LINKED, ignoring how
-- many test definitions the subject has. One pass against twenty approved definitions read
-- exactly like twenty passes. That is the failure mode a verification report exists to
-- prevent, so a column called `verified` must not have it.
--
-- The lifecycle state remains authoritative for whether an execution counts —
-- `invalidated_because` is the explanation, `core.object.lifecycle_state` is the fact. Only
-- `invalidate_test_execution` moves that state, so the two cannot disagree without an action
-- saying so.

drop view engineering.verification_status;

create view engineering.verification_status as
with executions as (
  select v.subject_id,
         e.test_definition,
         o.lifecycle_state,
         -- An execution with no timestamp did not happen, whatever its state says.
         (e.executed_on is not null) as actually_executed
    from engineering.verification_link v
    join engineering.test_execution e on e.id = v.execution_id
    join core.object o on o.id = e.id
),
definitions as (
  -- Every APPROVED definition that claims to verify this subject. A draft definition is not
  -- yet something anyone owes a result against; a superseded one has been replaced.
  select d.verifies as subject_id, d.id as definition_id
    from engineering.test_definition d
    join core.object o on o.id = d.id
   where o.lifecycle_state = 'approved'
)
select coalesce(x.subject_id, d.subject_id) as subject_id,
       count(*) filter (where x.lifecycle_state = 'passed' and x.actually_executed)      as passed,
       count(*) filter (where x.lifecycle_state = 'failed')                              as failed,
       count(*) filter (where x.lifecycle_state = 'invalidated')                         as invalidated,
       -- A result recorded without an execution behind it. Surfaced rather than dropped:
       -- silently ignoring it would hide a record that should never have been written.
       count(*) filter (where x.lifecycle_state in ('passed', 'failed')
                          and not x.actually_executed)                                   as unexecuted,
       count(x.subject_id)                                                               as executions,
       count(distinct d.definition_id)                                                   as approved_definitions,
       count(distinct x.test_definition) filter (where x.lifecycle_state = 'passed'
                                                   and x.actually_executed)              as definitions_passed,
       -- VERIFIED means: there is at least one approved definition, every one of them has a
       -- passing execution that actually ran, and nothing outstanding contradicts it.
       (count(distinct d.definition_id) > 0
        and count(distinct x.test_definition) filter (where x.lifecycle_state = 'passed'
                                                        and x.actually_executed)
            >= count(distinct d.definition_id)
        and count(*) filter (where x.lifecycle_state = 'failed') = 0)                    as verified
  from executions x
  full outer join definitions d on d.subject_id = x.subject_id
 group by coalesce(x.subject_id, d.subject_id);

comment on view engineering.verification_status is
  'Verification computed from executions, never stored. `verified` requires every approved '
  'test definition to have a passing execution that actually ran — one pass against twenty '
  'definitions is not verification, and a stored flag would have said it was.';

grant select on engineering.verification_status
  to kf_app, kf_worker, kf_readonly, kf_auditor;

-- ── two records that could close without deciding ──────────────────────────────────────

-- A complaint closed with `reportable` still null has no reportability decision at all, and
-- a null says even less than a bare false. The CHECK on the rationale only bound the case
-- where somebody HAD decided.
alter table quality.complaint
  add constraint complaint_closed_needs_reportability
    check (closed_at is null or reportable is not null);

-- ── attribution that pointed nowhere ───────────────────────────────────────────────────

-- `recorded_by` and `created_by` on the Gate 6 tables were plain uuids with nothing behind
-- them, so an audit trail could name an identity that does not exist. Every other schema
-- keys these to core.object; these were the ones that slipped.
alter table quality.federated_reference
  add constraint federated_reference_recorded_by_fk
    foreign key (recorded_by) references core.object (id) on delete restrict;
alter table quality.federated_link
  add constraint federated_link_created_by_fk
    foreign key (created_by) references core.object (id) on delete restrict;
alter table quality.supplier_qualification
  add constraint supplier_qualification_recorded_by_fk
    foreign key (recorded_by) references core.object (id) on delete restrict;
alter table quality.calibration
  add constraint calibration_recorded_by_fk
    foreign key (recorded_by) references core.object (id) on delete restrict;
alter table quality.training_record
  add constraint training_record_recorded_by_fk
    foreign key (recorded_by) references core.object (id) on delete restrict;
alter table product.interface_conformance
  add constraint interface_conformance_recorded_by_fk
    foreign key (recorded_by) references core.object (id) on delete restrict;
alter table engineering.verification_link
  add constraint verification_link_created_by_fk
    foreign key (created_by) references core.object (id) on delete restrict;

-- migrate:down

alter table engineering.verification_link drop constraint verification_link_created_by_fk;
alter table product.interface_conformance drop constraint interface_conformance_recorded_by_fk;
alter table quality.training_record drop constraint training_record_recorded_by_fk;
alter table quality.calibration drop constraint calibration_recorded_by_fk;
alter table quality.supplier_qualification drop constraint supplier_qualification_recorded_by_fk;
alter table quality.federated_link drop constraint federated_link_created_by_fk;
alter table quality.federated_reference drop constraint federated_reference_recorded_by_fk;
alter table quality.complaint drop constraint complaint_closed_needs_reportability;
drop view engineering.verification_status;
