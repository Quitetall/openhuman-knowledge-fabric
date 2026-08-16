-- migrate:up

-- ADR semantic linkage for ADR-0002.
--
-- The only new authoritative fact is the body link from an existing decision_record to an
-- authored document revision. Implementation, verification, progress and reconsideration
-- projections below are deterministic views over canonical core.relation, core.action and
-- engineering verification records, so ADR state cannot contradict the source ledgers.

create table content.adr_decision_body (
  id                    uuid primary key default uuidv7(),
  decision_id           uuid not null references core.object (id) on delete restrict,
  document_revision_id  uuid not null references content.authored_fragment_revision (id)
                          on delete restrict,
  body_state            text not null check (body_state in ('draft', 'accepted')),
  body_digest           text not null check (body_digest ~ '^[0-9a-f]{64}$'),
  recorded_at           timestamptz not null default now(),
  recorded_by_action    uuid not null references core.action (id) on delete restrict,

  unique (decision_id, document_revision_id, body_state)
);

create unique index adr_decision_body_one_accepted
  on content.adr_decision_body (decision_id) where body_state = 'accepted';

create index adr_body_by_decision on content.adr_decision_body (decision_id, recorded_at, id);

create function content.adr_expect_body_action(
  p_action uuid,
  p_decision core.object,
  p_revision content.authored_fragment_revision,
  p_body_state text,
  p_body_digest text
) returns core.action
language plpgsql
stable
as $$
declare
  v_action core.action%rowtype;
begin
  select * into v_action from core.action where id = p_action;
  if not found or v_action.id is distinct from core.current_action_id() then
    raise exception 'ADR body action must be the active transaction action'
      using errcode = 'foreign_key_violation';
  end if;
  if (p_body_state = 'draft' and v_action.action_type <> 'propose_decision')
     or (p_body_state = 'accepted' and v_action.action_type <> 'accept_decision') then
    raise exception 'ADR body action is not one of the allowed typed decision actions'
      using errcode = 'foreign_key_violation';
  end if;
  if v_action.organization_id is distinct from p_decision.organization_id then
    raise exception 'ADR body action organization does not match decision organization'
      using errcode = 'foreign_key_violation';
  end if;
  if v_action.target_ids is distinct from array[p_decision.id]::uuid[] then
    raise exception 'ADR body action targets do not exactly match ledger semantics'
      using errcode = 'foreign_key_violation';
  end if;
  if p_body_state = 'draft'
     and v_action.parameters is distinct from jsonb_build_object(
       'title', v_action.parameters ->> 'title',
       'document_revision_id', p_revision.id,
       'body_state', p_body_state,
       'body_digest', p_body_digest
     ) then
    raise exception 'ADR body action parameters do not exactly match ledger semantics'
      using errcode = 'foreign_key_violation';
  end if;
  if p_body_state = 'accepted'
     and v_action.parameters is distinct from jsonb_build_object(
       'document_revision_id', p_revision.id,
       'body_state', p_body_state,
       'body_digest', p_body_digest
     ) then
    raise exception 'ADR body action parameters do not exactly match ledger semantics'
      using errcode = 'foreign_key_violation';
  end if;
  return v_action;
end
$$;

create function content.adr_validate_decision_body() returns trigger
language plpgsql
as $$
declare
  v_decision core.object%rowtype;
  v_revision content.authored_fragment_revision%rowtype;
  v_revision_object core.object%rowtype;
  v_action core.action%rowtype;
begin
  select * into v_decision from core.object where id = new.decision_id;
  if not found or v_decision.object_type <> 'decision_record' then
    raise exception 'ADR body must attach to a decision_record object'
      using errcode = 'foreign_key_violation';
  end if;

  select * into v_revision
    from content.authored_fragment_revision where id = new.document_revision_id;
  if not found then
    raise exception 'ADR body document revision is missing'
      using errcode = 'foreign_key_violation';
  end if;
  if new.body_digest is distinct from v_revision.content_digest then
    raise exception 'ADR body digest must equal authored revision content_digest'
      using errcode = 'foreign_key_violation';
  end if;
  select revision_object.* into v_revision_object
    from content.document_subject subject
    join core.object revision_object on revision_object.id = subject.object_id
   where subject.id = v_revision.fragment_id
     and subject.subject_kind = 'fragment';
  if not found then
    raise exception 'ADR body revision has no governed fragment object'
      using errcode = 'foreign_key_violation';
  end if;
  if v_revision_object.organization_id is distinct from v_decision.organization_id then
    raise exception 'ADR body revision organization does not match decision organization'
      using errcode = 'foreign_key_violation';
  end if;
  if (select rank from registry.classification where id = v_revision_object.classification)
     > core.current_classification_rank() then
    raise exception 'ADR body revision is not visible to the active classification ceiling'
      using errcode = 'insufficient_privilege';
  end if;
  if (select rank from registry.classification where id = v_revision.classification)
     > core.current_classification_rank() then
    raise exception 'ADR body revision is not visible to the active classification ceiling'
      using errcode = 'insufficient_privilege';
  end if;

  if new.body_state = 'accepted' then
    if v_decision.lifecycle_state <> 'accepted' then
      raise exception 'accepted ADR bodies require an accepted decision_record'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if v_revision.revision_state <> 'active' then
      raise exception 'accepted ADR bodies require an active authored document revision'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  select * into v_action from content.adr_expect_body_action(
    new.recorded_by_action,
    v_decision,
    v_revision,
    new.body_state,
    new.body_digest
  );
  new.recorded_at := v_action.effective_at;
  return new;
end
$$;

create trigger adr_decision_body_append_only
  before update or delete or truncate on content.adr_decision_body
  for each statement execute function core.refuse_mutation();

create trigger adr_decision_body_validate
  before insert on content.adr_decision_body
  for each row execute function content.adr_validate_decision_body();

create view content.adr_implementation_link
with (security_invoker = true) as
  select relation.id,
         decision.id as decision_id,
         case implementation.object_type
           when 'work_execution' then 'work_execution'
           else 'change'
         end as implementation_kind,
         case when implementation.object_type = 'change_record'
              then implementation.id else null end as change_id,
         case when implementation.object_type = 'work_execution'
              then implementation.id else null end as work_execution_id,
         implementation.title as summary,
         relation.created_at as recorded_at,
         relation.authorizing_action as recorded_by_action
    from core.relation relation
    join core.object implementation on implementation.id = relation.source_id
    join core.object decision on decision.id = relation.target_id
   where relation.relation_type = 'implements'
     and relation.state = 'active'
     and implementation.object_type in ('change_record', 'work_execution')
     and decision.object_type = 'decision_record'
     and implementation.organization_id = core.current_organization()
     and decision.organization_id = core.current_organization()
     and (select rank from registry.classification where id = implementation.classification)
         <= core.current_classification_rank()
     and (select rank from registry.classification where id = decision.classification)
         <= core.current_classification_rank();

create view content.adr_decision_relation
with (security_invoker = true) as
  select relation.id,
         source_decision.id as source_decision_id,
         target_decision.id as target_decision_id,
         relation.relation_type as relation_kind,
         coalesce(relation.properties ->> 'rationale', source_decision.title) as rationale,
         relation.created_at as recorded_at,
         relation.authorizing_action as recorded_by_action
    from core.relation relation
    join core.object source_decision on source_decision.id = relation.source_id
    join core.object target_decision on target_decision.id = relation.target_id
   where relation.relation_type in ('supersedes', 'amends', 'extends')
     and relation.state = 'active'
     and source_decision.object_type = 'decision_record'
     and target_decision.object_type = 'decision_record'
     and source_decision.organization_id = core.current_organization()
     and target_decision.organization_id = core.current_organization()
     and (select rank from registry.classification where id = source_decision.classification)
         <= core.current_classification_rank()
     and (select rank from registry.classification where id = target_decision.classification)
         <= core.current_classification_rank();

create view content.adr_verification_evidence
with (security_invoker = true) as
  select coalesce(link.id, execution.id, definition.id) as id,
         decision.id as decision_id,
         definition.id as test_definition_id,
         execution.id as test_execution_id,
         link.id as verification_link_id,
         case
           when link.id is not null then 'link'
           when execution.id is not null then 'execution'
           else 'definition'
         end as evidence_role,
         coalesce(link.created_at, execution_object.updated_at,
                  definition_object.updated_at) as recorded_at,
         link.authorizing_action as recorded_by_action
    from core.object decision
    join engineering.test_definition definition on definition.verifies = decision.id
    join core.object definition_object on definition_object.id = definition.id
    left join engineering.test_execution execution on execution.test_definition = definition.id
    left join core.object execution_object on execution_object.id = execution.id
    left join engineering.verification_link link
      on link.subject_id = decision.id and link.execution_id = execution.id
   where decision.object_type = 'decision_record'
     and decision.organization_id = core.current_organization()
     and definition_object.organization_id = core.current_organization()
     and (execution_object.id is null
          or execution_object.organization_id = core.current_organization())
     and (select rank from registry.classification where id = decision.classification)
         <= core.current_classification_rank()
     and (select rank from registry.classification where id = definition_object.classification)
         <= core.current_classification_rank()
     and (execution_object.id is null
          or (select rank from registry.classification where id = execution_object.classification)
             <= core.current_classification_rank());

create view content.adr_activity
with (security_invoker = true) as
  select event.id,
         event.decision_id,
         row_number() over (partition by event.decision_id
                            order by event.recorded_at, event.source_seq, event.id)::integer
           as sequence_no,
         event.progress_kind,
         event.summary,
         event.change_id,
         event.work_execution_id,
         event.test_definition_id,
         event.test_execution_id,
         event.evidence_version_id,
         event.recorded_at,
         event.recorded_by_action
    from (
      select body.id,
             body.decision_id,
             case body.body_state when 'accepted' then 'completed' else 'progress' end
               as progress_kind,
             'ADR body ' || body.body_state as summary,
             null::uuid as change_id,
             null::uuid as work_execution_id,
             null::uuid as test_definition_id,
             null::uuid as test_execution_id,
             null::uuid as evidence_version_id,
             body.recorded_at,
             body.recorded_by_action,
             0::bigint as source_seq
        from content.adr_decision_body body
      union all
      select relation.id,
             relation.target_id,
             'progress'::text,
             'ADR implementation linked',
             case when implementation.object_type = 'change_record' then implementation.id else null end,
             case when implementation.object_type = 'work_execution' then implementation.id else null end,
             null::uuid,
             null::uuid,
             null::uuid,
             relation.created_at,
             relation.authorizing_action,
             0::bigint
        from core.relation relation
        join core.object implementation on implementation.id = relation.source_id
        join core.object decision on decision.id = relation.target_id
       where relation.relation_type = 'implements'
         and implementation.object_type in ('change_record', 'work_execution')
         and decision.object_type = 'decision_record'
         and implementation.organization_id = core.current_organization()
         and decision.organization_id = core.current_organization()
         and (select rank from registry.classification where id = implementation.classification)
             <= core.current_classification_rank()
         and (select rank from registry.classification where id = decision.classification)
             <= core.current_classification_rank()
      union all
      select audit.id,
             relation.target_id,
             case
               when action.action_type in ('verify_change', 'make_change_effective') then 'completed'
               when action.action_type = 'issue_acceptance'
                    and action.parameters ->> 'disposition' = 'rejected' then 'rejected'
               when action.action_type = 'approve_change'
                    and coalesce(case
                                   when jsonb_typeof(action.parameters -> 'to_state') = 'string'
                                     then action.parameters ->> 'to_state'
                                 end,
                                 action.parameters -> 'to_state' ->> implementation.id::text,
                                 action.parameters -> 'to_state' ->> implementation.object_type)
                        = 'rejected' then 'rejected'
               else 'progress'
             end,
             'ADR implementation action ' || action.action_type,
             case when implementation.object_type = 'change_record' then implementation.id else null end,
             case when implementation.object_type = 'work_execution' then implementation.id else null end,
             null::uuid,
             null::uuid,
             null::uuid,
             audit.effective_at,
             action.id,
             audit.seq
        from core.audit_event audit
        join core.action action on action.id = audit.action_id
        join core.object implementation on implementation.id = any(action.target_ids)
                                      and implementation.id = audit.object_id
        join core.relation relation
          on relation.relation_type = 'implements'
         and relation.source_id = implementation.id
        join core.object decision on decision.id = relation.target_id
       where action.action_type in (
               'open_change', 'approve_change', 'verify_change', 'make_change_effective',
               'submit_work_execution', 'review_work_execution', 'issue_acceptance'
             )
         and implementation.object_type in ('change_record', 'work_execution')
         and decision.object_type = 'decision_record'
         and implementation.organization_id = core.current_organization()
         and decision.organization_id = core.current_organization()
         and (select rank from registry.classification where id = implementation.classification)
             <= core.current_classification_rank()
         and (select rank from registry.classification where id = decision.classification)
             <= core.current_classification_rank()
      union all
      select definition.id,
             definition.verifies,
             'progress'::text,
             'ADR verification definition',
             null::uuid,
             null::uuid,
             definition.id,
             null::uuid,
             definition.procedure_version,
             definition_object.created_at,
             null::uuid,
             0::bigint
        from engineering.test_definition definition
        join core.object definition_object on definition_object.id = definition.id
        join core.object decision on decision.id = definition.verifies
       where decision.object_type = 'decision_record'
         and decision.organization_id = core.current_organization()
         and definition_object.organization_id = core.current_organization()
         and (select rank from registry.classification where id = decision.classification)
             <= core.current_classification_rank()
         and (select rank from registry.classification where id = definition_object.classification)
             <= core.current_classification_rank()
      union all
      select link.id,
             link.subject_id,
             'completed'::text,
             'ADR verification linked',
             null::uuid,
             null::uuid,
             execution.test_definition,
             link.execution_id,
             execution.evidence_version,
             link.created_at,
             link.authorizing_action,
             0::bigint
        from engineering.verification_link link
        join engineering.test_execution execution on execution.id = link.execution_id
        join core.object execution_object on execution_object.id = execution.id
        join core.object decision on decision.id = link.subject_id
       where decision.object_type = 'decision_record'
         and decision.organization_id = core.current_organization()
         and execution_object.organization_id = core.current_organization()
         and (select rank from registry.classification where id = decision.classification)
             <= core.current_classification_rank()
         and (select rank from registry.classification where id = execution_object.classification)
             <= core.current_classification_rank()
      union all
      select audit.id,
             definition.verifies,
             case
               when action.action_type = 'record_test_result'
                    and coalesce(case
                                   when jsonb_typeof(action.parameters -> 'to_state') = 'string'
                                     then action.parameters ->> 'to_state'
                                 end,
                                 action.parameters -> 'to_state' ->> execution.id::text,
                                 action.parameters -> 'to_state' ->> execution_object.object_type)
                        = 'passed' then 'completed'
               when action.action_type = 'record_test_result'
                    and coalesce(case
                                   when jsonb_typeof(action.parameters -> 'to_state') = 'string'
                                     then action.parameters ->> 'to_state'
                                 end,
                                 action.parameters -> 'to_state' ->> execution.id::text,
                                 action.parameters -> 'to_state' ->> execution_object.object_type)
                        = 'failed' then 'falsified'
               when action.action_type = 'invalidate_test_execution' then 'falsified'
               else 'progress'
             end,
             'ADR verification action ' || action.action_type,
             null::uuid,
             null::uuid,
             definition.id,
             execution.id,
             execution.evidence_version,
             audit.effective_at,
             action.id,
             audit.seq
        from core.audit_event audit
        join core.action action on action.id = audit.action_id
        join engineering.test_execution execution on execution.id = any(action.target_ids)
                                                 and execution.id = audit.object_id
        join core.object execution_object on execution_object.id = execution.id
        join engineering.test_definition definition on definition.id = execution.test_definition
        join core.object decision on decision.id = definition.verifies
       where action.action_type in (
               'plan_test_execution', 'execute_test', 'record_test_result',
               'invalidate_test_execution'
             )
         and decision.object_type = 'decision_record'
         and decision.organization_id = core.current_organization()
         and execution_object.organization_id = core.current_organization()
         and (select rank from registry.classification where id = decision.classification)
             <= core.current_classification_rank()
         and (select rank from registry.classification where id = execution_object.classification)
             <= core.current_classification_rank()
      union all
      select relation.id,
             relation.source_id,
             case relation.relation_type
               when 'supersedes' then 'completed'
               else 'progress'
             end as progress_kind,
             'ADR relation ' || relation.relation_type as summary,
             null::uuid,
             null::uuid,
             null::uuid,
             null::uuid,
             null::uuid,
             relation.created_at,
             relation.authorizing_action,
             0::bigint
        from core.relation relation
        join core.object source_decision on source_decision.id = relation.source_id
        join core.object target_decision on target_decision.id = relation.target_id
       where relation.relation_type in ('supersedes', 'amends', 'extends')
         and source_decision.object_type = 'decision_record'
         and target_decision.object_type = 'decision_record'
         and source_decision.organization_id = core.current_organization()
         and target_decision.organization_id = core.current_organization()
         and (select rank from registry.classification where id = source_decision.classification)
             <= core.current_classification_rank()
         and (select rank from registry.classification where id = target_decision.classification)
             <= core.current_classification_rank()
    ) event;

create view content.adr_overview
with (security_invoker = true) as
  select decision.id as decision_id,
         decision.enterprise_id,
         decision.title,
         decision.lifecycle_state,
         accepted.document_revision_id as accepted_document_revision_id,
         accepted.body_digest as accepted_body_digest,
         progress.progress_kind as latest_progress_kind,
         coalesce(progress_count.count, 0) as progress_event_count,
         coalesce(gate_debt.count, 0) as gate_debt_count
    from core.object decision
    left join lateral (
      select body.document_revision_id, body.body_digest
        from content.adr_decision_body body
       where body.decision_id = decision.id and body.body_state = 'accepted'
       order by body.recorded_at desc, body.id desc
       limit 1
    ) accepted on true
    left join lateral (
      select event.progress_kind
        from content.adr_activity event
       where event.decision_id = decision.id
       order by event.sequence_no desc
       limit 1
    ) progress on true
    left join lateral (
      select count(*)::integer as count
        from content.adr_activity event
       where event.decision_id = decision.id
    ) progress_count on true
    left join lateral (
      select count(*)::integer as count
        from (
          select evidence.*,
                 execution_object.lifecycle_state as execution_state,
                 row_number() over (
                   partition by evidence.decision_id, evidence.test_definition_id
                   order by evidence.recorded_at desc,
                            (evidence.test_execution_id is not null) desc,
                            evidence.id desc
                 ) as latest_rank
            from content.adr_verification_evidence evidence
            left join engineering.test_execution execution
              on execution.id = evidence.test_execution_id
            left join core.object execution_object on execution_object.id = execution.id
           where evidence.decision_id = decision.id
        ) latest
       where latest.latest_rank = 1
         and (latest.test_execution_id is null or latest.execution_state <> 'passed')
    ) gate_debt on true
   where decision.object_type = 'decision_record'
     and decision.organization_id = core.current_organization()
     and (select rank from registry.classification where id = decision.classification)
         <= core.current_classification_rank();

create view content.adr_work_board
with (security_invoker = true) as
  select overview.decision_id,
         overview.title,
         overview.lifecycle_state,
         overview.latest_progress_kind,
         count(distinct implementation.id)::integer as implementation_count,
         count(distinct verification.id)::integer as verification_count,
         max(progress.recorded_at) as last_activity_at
    from content.adr_overview overview
    left join content.adr_implementation_link implementation
      on implementation.decision_id = overview.decision_id
    left join content.adr_verification_evidence verification
      on verification.decision_id = overview.decision_id
    left join content.adr_activity progress
      on progress.decision_id = overview.decision_id
   group by overview.decision_id, overview.title, overview.lifecycle_state,
            overview.latest_progress_kind;

create view content.adr_digest
with (security_invoker = true) as
  select overview.decision_id,
         jsonb_build_object(
           'decision_id', overview.decision_id,
           'enterprise_id', overview.enterprise_id,
           'title', overview.title,
           'state', overview.lifecycle_state,
           'accepted_document_revision_id', overview.accepted_document_revision_id,
           'latest_progress_kind', overview.latest_progress_kind,
           'gate_debt_count', overview.gate_debt_count
         ) as digest
    from content.adr_overview overview;

create view content.adr_topic
with (security_invoker = true) as
  select decision_id,
         lower(regexp_replace(coalesce(enterprise_id, title), '[^a-zA-Z0-9]+', '-', 'g'))
           as topic_key,
         title,
         lifecycle_state
    from content.adr_overview;

create view content.adr_gate_debt
with (security_invoker = true) as
  select latest.decision_id,
         latest.test_definition_id,
         latest.test_execution_id,
         case
           when latest.test_execution_id is null then 'missing_execution'
           when latest.execution_state = 'failed' then 'failed'
           when latest.execution_state = 'invalidated' then 'invalidated'
           when latest.execution_state <> 'passed' then 'not_passed'
           else 'none'
         end as debt_kind
    from (
      select evidence.*,
             execution_object.lifecycle_state as execution_state,
             row_number() over (
               partition by evidence.decision_id, evidence.test_definition_id
               order by evidence.recorded_at desc,
                        (evidence.test_execution_id is not null) desc,
                        evidence.id desc
             ) as latest_rank
        from content.adr_verification_evidence evidence
        left join engineering.test_execution execution on execution.id = evidence.test_execution_id
        left join core.object execution_object on execution_object.id = execution.id
    ) latest
   where latest.latest_rank = 1
     and (latest.test_execution_id is null or latest.execution_state <> 'passed');

alter table content.adr_decision_body enable row level security;
alter table content.adr_decision_body force row level security;

create policy adr_decision_body_read on content.adr_decision_body for select using (
  exists (
    select 1 from core.object decision
     where decision.id = decision_id
       and decision.organization_id = core.current_organization()
       and (select rank from registry.classification where id = decision.classification)
           <= core.current_classification_rank()
  )
);

create policy adr_decision_body_insert on content.adr_decision_body for insert with check (
  exists (
    select 1 from core.object decision
     where decision.id = decision_id
       and decision.organization_id = core.current_organization()
       and (select rank from registry.classification where id = decision.classification)
           <= core.current_classification_rank()
  )
);

create policy adr_decision_body_backup on content.adr_decision_body
  for select to kf_backup using (true);

grant select on content.adr_decision_body, content.adr_implementation_link,
                content.adr_activity, content.adr_verification_evidence,
                content.adr_decision_relation, content.adr_overview,
                content.adr_work_board, content.adr_digest, content.adr_topic,
                content.adr_gate_debt
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on content.adr_decision_body to kf_app;
grant select on content.adr_overview, content.adr_work_board, content.adr_digest,
                content.adr_topic, content.adr_gate_debt
  to kf_checkpoint;
grant usage, select on all sequences in schema content to kf_app, kf_worker;

comment on table content.adr_decision_body is
  'Append-only ADR body link: existing decision_record to authored ADR document revision. body_digest is the revision content_digest.';
comment on view content.adr_implementation_link is
  'Derived ADR implementation links over canonical core.relation implements edges.';
comment on view content.adr_decision_relation is
  'Derived ADR reconsideration links over canonical core.relation supersedes/amends/extends edges.';

-- migrate:down

drop view content.adr_gate_debt;
drop view content.adr_topic;
drop view content.adr_digest;
drop view content.adr_work_board;
drop view content.adr_overview;
drop view content.adr_activity;
drop view content.adr_verification_evidence;
drop view content.adr_decision_relation;
drop view content.adr_implementation_link;

drop table content.adr_decision_body;

drop function content.adr_validate_decision_body();
drop function content.adr_expect_body_action(uuid, core.object, content.authored_fragment_revision, text, text);
