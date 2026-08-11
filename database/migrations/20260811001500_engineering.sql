-- migrate:up

-- The engineering schema: decisions, changes, requirements, risks, controls and verification.
--
-- The point of this schema is the last two words. A requirement nobody verified is a wish; a
-- risk control nobody verified is a claim. The tables here exist so that "verified" is a row
-- with a method, an execution and a result behind it, rather than a checkbox.

create table engineering.decision_alternative (
  id            uuid primary key default uuidv7(),
  decision_id   uuid not null references core.object (id) on delete restrict,
  summary       text not null check (length(btrim(summary)) between 1 and 4000),
  -- Why it was NOT chosen. Recording only the winner turns a decision record into an
  -- announcement, and the question asked years later is always "did you consider X".
  rejected_because text not null check (length(btrim(rejected_because)) between 1 and 4000)
);

create index alternative_by_decision on engineering.decision_alternative (decision_id);

create table engineering.change_item (
  id            uuid primary key default uuidv7(),
  change_id     uuid not null references core.object (id) on delete restrict,
  subject_id    uuid not null references core.object (id) on delete restrict,
  impact        text not null check (impact in ('added', 'modified', 'removed', 'unaffected')),
  note          text,

  unique (change_id, subject_id)
);

create table engineering.risk_control (
  id            uuid primary key references core.object (id) on delete restrict,
  control_kind  text not null check (control_kind in (
    -- ISO 14971 order, and the order is the point: a protective measure is only acceptable
    -- once inherent safety has been considered and found insufficient.
    'inherent_safety', 'protective_measure', 'information_for_safety'
  )),
  mitigates     uuid not null references core.object (id) on delete restrict,
  description   text not null check (length(btrim(description)) between 1 and 4000),
  implemented_in uuid references product.configuration_item (id) on delete restrict
);

create index risk_control_by_risk on engineering.risk_control (mitigates);

create table engineering.test_definition (
  id                   uuid primary key references core.object (id) on delete restrict,
  method_kind          text not null check (method_kind in (
    'inspection', 'analysis', 'demonstration', 'test'
  )),
  acceptance_criterion text not null check (length(btrim(acceptance_criterion)) between 1 and 4000),
  -- What this verifies: a requirement, a risk control, an interface contract. Any of them,
  -- so it references the object rather than one specific table.
  verifies             uuid not null references core.object (id) on delete restrict,
  procedure_version    uuid references content.artifact_version (id) on delete restrict
);

create index test_definition_by_subject on engineering.test_definition (verifies);

create table engineering.test_execution (
  id             uuid primary key references core.object (id) on delete restrict,
  test_definition uuid not null references engineering.test_definition (id) on delete restrict,
  executed_on    timestamptz,
  executed_by    uuid references core.object (id) on delete restrict,
  -- The exact build tested. A result that does not name what was under test cannot be
  -- attached to anything afterwards.
  configuration_item uuid references product.configuration_item (id) on delete restrict,
  result_summary text,
  evidence_version uuid references content.artifact_version (id) on delete restrict,
  -- Why a result stopped counting. Set when an execution is invalidated: expired
  -- calibration, wrong build, wrong procedure revision.
  invalidated_because text
);

create index test_execution_by_definition on engineering.test_execution (test_definition);

-- Which equipment produced a result. This is the join that makes an expired calibration
-- actionable: given a calibration found out of tolerance, every execution that used that
-- equipment since the last good calibration is suspect, and this table is how you find them.
create table engineering.test_execution_equipment (
  execution_id uuid not null references engineering.test_execution (id) on delete restrict,
  equipment_id uuid not null references quality.equipment (id) on delete restrict,
  primary key (execution_id, equipment_id)
);

-- The verification spine: what satisfies what, and on the strength of which execution.
create table engineering.verification_link (
  id            uuid primary key default uuidv7(),
  -- The thing being verified: a requirement, a risk control, an interface contract.
  subject_id    uuid not null references core.object (id) on delete restrict,
  execution_id  uuid not null references engineering.test_execution (id) on delete restrict,
  created_at    timestamptz not null default now(),
  created_by    uuid not null,
  authorizing_action uuid references core.action (id),

  unique (subject_id, execution_id)
);

create index verification_link_by_subject on engineering.verification_link (subject_id);

/*
 * Verification status, computed rather than stored.
 *
 * A stored "verified" flag is a number that can disagree with the records underneath it, and
 * it always eventually does — a test gets invalidated and the flag stays true. This view has
 * no such failure mode: it reads the executions, and an invalidated one stops counting the
 * moment it is invalidated.
 */
create view engineering.verification_status as
  select v.subject_id,
         count(*) filter (where o.lifecycle_state = 'passed')      as passed,
         count(*) filter (where o.lifecycle_state = 'failed')      as failed,
         count(*) filter (where o.lifecycle_state = 'invalidated') as invalidated,
         count(*)                                                  as total,
         -- Verified means: at least one pass, and nothing outstanding that contradicts it.
         (count(*) filter (where o.lifecycle_state = 'passed') > 0
          and count(*) filter (where o.lifecycle_state = 'failed') = 0) as verified
    from engineering.verification_link v
    join engineering.test_execution e on e.id = v.execution_id
    join core.object o on o.id = e.id
   group by v.subject_id;

grant select on all tables in schema engineering
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant select on engineering.verification_status
  to kf_app, kf_worker, kf_readonly, kf_auditor;
grant insert on engineering.decision_alternative, engineering.change_item,
                engineering.risk_control, engineering.test_definition,
                engineering.test_execution, engineering.test_execution_equipment,
                engineering.verification_link
  to kf_app;
grant update (executed_on, executed_by, configuration_item, result_summary, evidence_version,
              invalidated_because)
  on engineering.test_execution to kf_app;
grant update (implemented_in) on engineering.risk_control to kf_app;
grant usage, select on all sequences in schema engineering to kf_app, kf_worker;

-- migrate:down

drop view engineering.verification_status;
drop table engineering.verification_link;
drop table engineering.test_execution_equipment;
drop table engineering.test_execution;
drop table engineering.test_definition;
drop table engineering.risk_control;
drop table engineering.change_item;
drop table engineering.decision_alternative;
