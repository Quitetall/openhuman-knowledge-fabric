-- migrate:up

-- BLUT and other exact ML workloads register privacy-minimal provenance through typed KF
-- actions. No function in this migration signs, seals, qualifies, promotes, allocates a
-- governed identifier, or stores private key material.

create table ml.registry_registration (
  record_kind      text not null check (record_kind in (
    'aggregate_reference', 'run_lineage', 'metric_definition', 'metric_segment'
  )),
  record_id        uuid not null,
  organization_id  uuid not null references org.organization (id) on delete restrict,
  action_id        uuid not null unique references core.action (id) on delete restrict,
  registered_at    timestamptz not null,
  primary key (record_kind, record_id)
);

create function ml.enforce_registry_registration() returns trigger
language plpgsql
set search_path = pg_catalog, core, ml
as $$
declare
  v_record_organization uuid;
  v_action_organization uuid;
  v_action_type text;
  v_effective_at timestamptz;
  v_expected_action_type text;
begin
  case new.record_kind
    when 'aggregate_reference' then
      select reference.organization_id into v_record_organization
        from ml.aggregate_reference reference where reference.id = new.record_id;
      v_expected_action_type := 'register_ml_aggregate_reference';
    when 'run_lineage' then
      select reference.organization_id into v_record_organization
        from ml.run_lineage lineage
        join ml.aggregate_reference reference on reference.id = lineage.run_ref_id
       where lineage.id = new.record_id;
      v_expected_action_type := 'register_ml_run_lineage';
    when 'metric_definition' then
      select reference.organization_id into v_record_organization
        from ml.metric_definition definition
        join ml.aggregate_reference reference on reference.id = definition.definition_ref_id
       where definition.id = new.record_id;
      v_expected_action_type := 'register_ml_metric_definition';
    when 'metric_segment' then
      select reference.organization_id into v_record_organization
        from ml.metric_segment segment
        join ml.aggregate_reference reference on reference.id = segment.segment_ref_id
       where segment.id = new.record_id;
      v_expected_action_type := 'register_ml_metric_segment';
    else
      raise exception 'unsupported ML registry registration kind %', new.record_kind
        using errcode = 'check_violation';
  end case;
  select action.organization_id, action.action_type, action.effective_at
    into v_action_organization, v_action_type, v_effective_at
    from core.action action where action.id = new.action_id;
  if v_record_organization is null
     or new.organization_id is distinct from v_record_organization
     or new.organization_id is distinct from v_action_organization
     or v_action_type is distinct from v_expected_action_type
     or new.registered_at is distinct from v_effective_at then
    raise exception 'ML registry registration does not bind its exact record, action, organization, and effective time'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger registry_registration_validate
  before insert on ml.registry_registration
  for each row execute function ml.enforce_registry_registration();
create trigger registry_registration_append_only
  before update or delete or truncate on ml.registry_registration
  for each statement execute function ml.refuse_mutation();

alter table ml.registry_registration enable row level security;
alter table ml.registry_registration force row level security;
create policy registry_registration_preservation on ml.registry_registration
  for select to kf_auditor, kf_backup using (true);
create policy registry_registration_owner on ml.registry_registration
  for all to kf_migrator using (true) with check (true);
create policy registry_registration_organization_read on ml.registry_registration
  for select to kf_app, kf_worker, kf_ml_promoter, kf_readonly using (
    organization_id = core.current_organization()
    and case record_kind
      when 'aggregate_reference' then exists (
        select 1 from ml.aggregate_reference reference
        join registry.classification classification
          on classification.id = reference.classification_id
        where reference.id = record_id
          and classification.rank <= core.current_classification_rank()
      )
      when 'run_lineage' then exists (
        select 1 from ml.run_lineage lineage
        join ml.aggregate_reference reference on reference.id = lineage.run_ref_id
        join registry.classification classification
          on classification.id = reference.classification_id
        where lineage.id = record_id
          and classification.rank <= core.current_classification_rank()
      )
      when 'metric_definition' then exists (
        select 1 from ml.metric_definition definition
        join ml.aggregate_reference reference on reference.id = definition.definition_ref_id
        join registry.classification classification
          on classification.id = reference.classification_id
        where definition.id = record_id
          and classification.rank <= core.current_classification_rank()
      )
      when 'metric_segment' then exists (
        select 1 from ml.metric_segment segment
        join ml.aggregate_reference reference on reference.id = segment.segment_ref_id
        join registry.classification classification
          on classification.id = reference.classification_id
        where segment.id = record_id
          and classification.rank <= core.current_classification_rank()
      )
      else false
    end
  );

revoke all on ml.registry_registration from public, kf_app, kf_worker, kf_ml_promoter, kf_readonly;
grant select on ml.registry_registration
  to kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;
grant select, insert on ml.registry_registration to kf_migrator;

create function ml.require_exact_registry_action(
  p_action_type text,
  p_organization_id uuid,
  p_parameters jsonb
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, org, registry, ml
as $$
declare
  v_actor uuid := core.current_actor();
  v_action_id uuid := core.current_action_id();
  v_role_setting text := nullif(current_setting('kf.acting_role', true), '');
  v_request_id text := nullif(current_setting('kf.request_id', true), '');
  v_role_id uuid;
  v_action core.action%rowtype;
begin
  if p_action_type not in (
    'register_ml_aggregate_reference', 'register_ml_run_lineage',
    'register_ml_metric_definition', 'register_ml_metric_segment'
  ) then
    raise exception 'ML action % has no registry-registration policy', p_action_type
      using errcode = 'insufficient_privilege';
  end if;
  if v_action_id is null or v_role_setting is null then
    raise exception 'ML registry write requires exact open typed-action context'
      using errcode = 'insufficient_privilege';
  end if;
  begin
    v_role_id := v_role_setting::uuid;
  exception when invalid_text_representation then
    raise exception 'ML registry write has an invalid acting-role context'
      using errcode = 'insufficient_privilege';
  end;
  select action.* into v_action from core.action action where action.id = v_action_id;
  if not found
     or v_action.action_type is distinct from p_action_type
     or v_action.result_status is distinct from 'applied'
     or v_action.actor_id is distinct from v_actor
     or v_action.acting_role_id is distinct from v_role_id
     or v_action.request_id is distinct from v_request_id
     or v_action.target_ids is distinct from array[p_organization_id]::uuid[]
     or v_action.parameters is distinct from p_parameters then
    raise exception 'ML registry write context does not match its exact recorded action semantics'
      using errcode = 'integrity_constraint_violation';
  end if;
  if not exists (
    select 1 from core.action action
     where action.id = v_action_id
       and action.xmin::text = pg_current_xact_id()::text
  ) or exists (select 1 from core.audit_event event where event.action_id = v_action_id) then
    raise exception 'ML registry action must run before audit in its creating transaction'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if core.current_organization() is distinct from p_organization_id or not exists (
    select 1 from core.object object
     where object.id = p_organization_id
       and object.object_type = 'organization'
       and object.organization_id = p_organization_id
       and (select classification.rank from registry.classification classification
             where classification.id = object.classification)
           <= core.current_classification_rank()
  ) then
    raise exception 'ML target organization does not exist or is not visible'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from org.role_assignment assignment
    join core.object assignment_object on assignment_object.id = assignment.id
    join core.object person_object on person_object.id = assignment.subject_id
     where assignment.id = v_role_id
       and assignment.subject_id = v_actor
       and assignment.scope_id = p_organization_id
       and assignment.role_id in ('performer', 'technical_authority')
       and assignment.valid_from <= v_action.effective_at
       and (assignment.valid_to is null or assignment.valid_to > v_action.effective_at)
       and assignment_object.lifecycle_state = 'active'
       and person_object.lifecycle_state = 'active'
  ) then
    raise exception 'ML registry action requires an active performer or technical authority'
      using errcode = 'insufficient_privilege';
  end if;
  return v_action_id;
end
$$;

create function ml.append_registry_registration(
  p_record_kind text,
  p_record_id uuid,
  p_organization_id uuid,
  p_action_id uuid
) returns void
language plpgsql
security definer
set search_path = pg_catalog, core, ml
as $$
declare
  v_existing ml.registry_registration%rowtype;
  v_effective_at timestamptz;
begin
  select action.effective_at into strict v_effective_at
    from core.action action where action.id = p_action_id;
  select registration.* into v_existing
    from ml.registry_registration registration
   where registration.record_kind = p_record_kind
     and registration.record_id = p_record_id;
  if found then
    if v_existing.action_id is distinct from p_action_id
       or v_existing.organization_id is distinct from p_organization_id then
      raise exception 'ML registry record was already registered by another action'
        using errcode = 'unique_violation';
    end if;
    return;
  end if;
  insert into ml.registry_registration(
    record_kind, record_id, organization_id, action_id, registered_at
  ) values (p_record_kind, p_record_id, p_organization_id, p_action_id, v_effective_at);
end
$$;

create function ml.register_aggregate_reference_action(
  p_id uuid,
  p_kind text,
  p_authority_id text,
  p_revision_id text,
  p_sha256 text,
  p_classification_id text,
  p_policy_id text
) returns table (id uuid, action_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, core, registry, ml
as $$
declare
  v_organization_id uuid := core.current_organization();
  v_action_id uuid;
  v_expected jsonb;
  v_reference ml.aggregate_reference%rowtype;
  v_match_count integer;
begin
  v_expected := jsonb_build_object(
    'referenceId', p_id::text, 'kind', p_kind, 'authorityId', p_authority_id,
    'revisionId', p_revision_id, 'sha256', p_sha256,
    'classificationId', p_classification_id, 'policyId', p_policy_id
  );
  v_action_id := ml.require_exact_registry_action(
    'register_ml_aggregate_reference', v_organization_id, v_expected
  );
  if not exists (
    select 1 from registry.classification classification
     where classification.id = p_classification_id
       and classification.rank <= core.current_classification_rank()
  ) then
    raise exception 'aggregate classification is unavailable at the current ceiling'
      using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'kf:ml:reference:' || v_organization_id::text || ':' || p_authority_id || ':' || p_revision_id,
    0
  ));
  select count(*) into v_match_count from ml.aggregate_reference reference
   where reference.id = p_id
      or (reference.organization_id = v_organization_id
          and reference.authority_id = p_authority_id
          and reference.revision_id = p_revision_id);
  if v_match_count > 1 then
    raise exception 'aggregate internal identity conflicts with an existing authority revision'
      using errcode = 'unique_violation';
  end if;
  select reference.* into v_reference from ml.aggregate_reference reference
   where reference.id = p_id
      or (reference.organization_id = v_organization_id
          and reference.authority_id = p_authority_id
          and reference.revision_id = p_revision_id);
  if found then
    if v_reference.id is distinct from p_id
       or v_reference.organization_id is distinct from v_organization_id
       or v_reference.aggregate_kind is distinct from p_kind
       or v_reference.authority_id is distinct from p_authority_id
       or v_reference.revision_id is distinct from p_revision_id
       or v_reference.sha256 is distinct from p_sha256
       or v_reference.classification_id is distinct from p_classification_id
       or v_reference.policy_id is distinct from p_policy_id then
      raise exception 'aggregate reference identity was already used for different exact bytes'
        using errcode = 'unique_violation';
    end if;
  else
    insert into ml.aggregate_reference(
      id, organization_id, aggregate_kind, authority_id, revision_id, sha256,
      classification_id, policy_id
    ) values (
      p_id, v_organization_id, p_kind, p_authority_id, p_revision_id, p_sha256,
      p_classification_id, p_policy_id
    ) returning * into strict v_reference;
  end if;
  perform ml.append_registry_registration(
    'aggregate_reference', v_reference.id, v_organization_id, v_action_id
  );
  return query select v_reference.id, v_action_id;
end
$$;

create function ml.register_run_lineage_action(
  p_id uuid,
  p_run_ref_id uuid,
  p_code_ref_id uuid,
  p_recipe_ref_id uuid,
  p_environment_ref_id uuid,
  p_metric_policy_ref_id uuid,
  p_input_ref_ids uuid[],
  p_output_ref_ids uuid[],
  p_parent_model_ref_ids uuid[],
  p_lineage_sha256 text
) returns table (id uuid, action_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, core, registry, ml, public
as $$
declare
  v_organization_id uuid := core.current_organization();
  v_action_id uuid;
  v_expected jsonb;
  v_inputs_json text;
  v_outputs_json text;
  v_parents_json text;
  v_lineage_json text;
  v_computed_sha256 text;
  v_lineage ml.run_lineage%rowtype;
  v_stored_inputs uuid[];
  v_stored_outputs uuid[];
  v_stored_parents uuid[];
  v_all_refs uuid[];
  v_registered_count integer;
  v_reference_count integer;
begin
  if cardinality(p_input_ref_ids) < 1 or cardinality(p_output_ref_ids) < 1
     or cardinality(p_input_ref_ids) > 10000 or cardinality(p_output_ref_ids) > 10000
     or cardinality(p_parent_model_ref_ids) > 10000
     or cardinality(p_input_ref_ids) <> cardinality(array(select distinct unnest(p_input_ref_ids)))
     or cardinality(p_output_ref_ids) <> cardinality(array(select distinct unnest(p_output_ref_ids)))
     or cardinality(p_parent_model_ref_ids) <> cardinality(array(select distinct unnest(p_parent_model_ref_ids))) then
    raise exception 'run lineage members must be bounded, nonempty where required, and unique'
      using errcode = 'check_violation';
  end if;
  v_expected := jsonb_build_object(
    'lineageId', p_id::text, 'runRefId', p_run_ref_id::text,
    'codeRefId', p_code_ref_id::text, 'recipeRefId', p_recipe_ref_id::text,
    'environmentRefId', p_environment_ref_id::text,
    'metricPolicyRefId', p_metric_policy_ref_id::text,
    'inputRefIds', to_jsonb(p_input_ref_ids::text[]),
    'outputRefIds', to_jsonb(p_output_ref_ids::text[]),
    'parentModelRefIds', to_jsonb(p_parent_model_ref_ids::text[]),
    'lineageDigest', p_lineage_sha256
  );
  v_action_id := ml.require_exact_registry_action(
    'register_ml_run_lineage', v_organization_id, v_expected
  );
  v_all_refs := array[p_run_ref_id, p_code_ref_id, p_recipe_ref_id,
                      p_environment_ref_id, p_metric_policy_ref_id]
                || p_input_ref_ids || p_output_ref_ids || p_parent_model_ref_ids;
  select count(*) into v_reference_count
    from unnest(v_all_refs) item(id)
    join ml.aggregate_reference reference on reference.id = item.id
    join registry.classification classification on classification.id = reference.classification_id
   where reference.organization_id = v_organization_id
     and classification.rank <= core.current_classification_rank();
  if v_reference_count <> cardinality(v_all_refs)
     or (select aggregate_kind from ml.aggregate_reference where id = p_run_ref_id) <> 'run'
     or (select aggregate_kind from ml.aggregate_reference where id = p_code_ref_id) <> 'code'
     or (select aggregate_kind from ml.aggregate_reference where id = p_recipe_ref_id) <> 'recipe'
     or (select aggregate_kind from ml.aggregate_reference where id = p_environment_ref_id) <> 'environment'
     or (select aggregate_kind from ml.aggregate_reference where id = p_metric_policy_ref_id) <> 'metric_policy'
     or exists (select 1 from unnest(p_input_ref_ids) item(id)
                 join ml.aggregate_reference reference on reference.id = item.id
                where reference.aggregate_kind <> 'input')
     or exists (select 1 from unnest(p_output_ref_ids) item(id)
                 join ml.aggregate_reference reference on reference.id = item.id
                where reference.aggregate_kind not in ('output', 'candidate'))
     or exists (select 1 from unnest(p_parent_model_ref_ids) item(id)
                 join ml.aggregate_reference reference on reference.id = item.id
                where reference.aggregate_kind <> 'parent_model') then
    raise exception 'run lineage references are unavailable, cross-organization, hidden, or incorrectly typed'
      using errcode = 'insufficient_privilege';
  end if;
  select count(*) into v_registered_count
    from unnest(v_all_refs) item(id)
    join ml.registry_registration registration
      on registration.record_kind = 'aggregate_reference' and registration.record_id = item.id
   where registration.organization_id = v_organization_id;
  if v_registered_count <> cardinality(v_all_refs) then
    raise exception 'run lineage requires action-registered aggregate references'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select '[' || string_agg(ml.canonical_aggregate_reference(item.id), ',' order by item.ordinal) || ']'
    into v_inputs_json from unnest(p_input_ref_ids) with ordinality item(id, ordinal);
  select '[' || string_agg(ml.canonical_aggregate_reference(item.id), ',' order by item.ordinal) || ']'
    into v_outputs_json from unnest(p_output_ref_ids) with ordinality item(id, ordinal);
  select coalesce('[' || string_agg(ml.canonical_aggregate_reference(item.id), ',' order by item.ordinal) || ']', '[]')
    into v_parents_json from unnest(p_parent_model_ref_ids) with ordinality item(id, ordinal);
  v_lineage_json := '{'
    || '"code":' || ml.canonical_aggregate_reference(p_code_ref_id)
    || ',"environment":' || ml.canonical_aggregate_reference(p_environment_ref_id)
    || ',"inputs":' || v_inputs_json
    || ',"metricPolicy":' || ml.canonical_aggregate_reference(p_metric_policy_ref_id)
    || ',"outputs":' || v_outputs_json
    || ',"parentModels":' || v_parents_json
    || ',"recipe":' || ml.canonical_aggregate_reference(p_recipe_ref_id)
    || ',"run":' || ml.canonical_aggregate_reference(p_run_ref_id)
    || ',"schemaVersion":"kf.ml.run-lineage.v1"}';
  v_computed_sha256 := encode(public.digest(convert_to(v_lineage_json, 'UTF8'), 'sha256'), 'hex');
  if p_lineage_sha256 !~ '^[0-9a-f]{64}$' or p_lineage_sha256 is distinct from v_computed_sha256 then
    raise exception 'run lineage digest does not match exact canonical registered references'
      using errcode = 'integrity_constraint_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kf:ml:lineage:' || p_run_ref_id::text, 0));
  select lineage.* into v_lineage from ml.run_lineage lineage
   where lineage.id = p_id or lineage.run_ref_id = p_run_ref_id
      or lineage.lineage_sha256 = p_lineage_sha256;
  if found then
    select array_agg(member.aggregate_ref_id order by member.ordinal) into v_stored_inputs
      from ml.run_lineage_input member where member.run_lineage_id = v_lineage.id;
    select array_agg(member.aggregate_ref_id order by member.ordinal) into v_stored_outputs
      from ml.run_lineage_output member where member.run_lineage_id = v_lineage.id;
    select coalesce(array_agg(member.aggregate_ref_id order by member.ordinal), '{}'::uuid[])
      into v_stored_parents from ml.run_lineage_parent_model member
     where member.run_lineage_id = v_lineage.id;
    if v_lineage.id is distinct from p_id or v_lineage.run_ref_id is distinct from p_run_ref_id
       or v_lineage.code_ref_id is distinct from p_code_ref_id
       or v_lineage.recipe_ref_id is distinct from p_recipe_ref_id
       or v_lineage.environment_ref_id is distinct from p_environment_ref_id
       or v_lineage.metric_policy_ref_id is distinct from p_metric_policy_ref_id
       or v_lineage.lineage_sha256 is distinct from p_lineage_sha256
       or v_stored_inputs is distinct from p_input_ref_ids
       or v_stored_outputs is distinct from p_output_ref_ids
       or v_stored_parents is distinct from p_parent_model_ref_ids then
      raise exception 'run lineage identity was already used for different exact members'
        using errcode = 'unique_violation';
    end if;
  else
    insert into ml.run_lineage(
      id, run_ref_id, code_ref_id, recipe_ref_id, environment_ref_id,
      metric_policy_ref_id, lineage_sha256
    ) values (
      p_id, p_run_ref_id, p_code_ref_id, p_recipe_ref_id, p_environment_ref_id,
      p_metric_policy_ref_id, p_lineage_sha256
    ) returning * into strict v_lineage;
    insert into ml.run_lineage_input(run_lineage_id, ordinal, aggregate_ref_id)
      select p_id, item.ordinal, item.id
        from unnest(p_input_ref_ids) with ordinality item(id, ordinal);
    insert into ml.run_lineage_output(run_lineage_id, ordinal, aggregate_ref_id)
      select p_id, item.ordinal, item.id
        from unnest(p_output_ref_ids) with ordinality item(id, ordinal);
    insert into ml.run_lineage_parent_model(run_lineage_id, ordinal, aggregate_ref_id)
      select p_id, item.ordinal, item.id
        from unnest(p_parent_model_ref_ids) with ordinality item(id, ordinal);
  end if;
  perform ml.append_registry_registration('run_lineage', v_lineage.id, v_organization_id, v_action_id);
  return query select v_lineage.id, v_action_id;
end
$$;

create function ml.register_metric_definition_action(
  p_id uuid,
  p_definition_ref_id uuid,
  p_metric_id text,
  p_value_kind text,
  p_unit_id text,
  p_allowed_enum_ids text[]
) returns table (id uuid, action_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, core, registry, ml
as $$
declare
  v_organization_id uuid := core.current_organization();
  v_action_id uuid;
  v_expected jsonb;
  v_definition ml.metric_definition%rowtype;
begin
  v_expected := jsonb_build_object(
    'definitionId', p_id::text, 'definitionRefId', p_definition_ref_id::text,
    'metricId', p_metric_id, 'valueKind', p_value_kind, 'unitId', p_unit_id,
    'allowedEnumIds', to_jsonb(p_allowed_enum_ids)
  );
  v_action_id := ml.require_exact_registry_action(
    'register_ml_metric_definition', v_organization_id, v_expected
  );
  if not exists (
    select 1 from ml.aggregate_reference reference
    join registry.classification classification on classification.id = reference.classification_id
    join ml.registry_registration registration
      on registration.record_kind = 'aggregate_reference' and registration.record_id = reference.id
     where reference.id = p_definition_ref_id
       and reference.organization_id = v_organization_id
       and reference.aggregate_kind = 'metric_definition'
       and classification.rank <= core.current_classification_rank()
       and registration.organization_id = v_organization_id
  ) then
    raise exception 'metric definition reference is unavailable or not action-registered'
      using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kf:ml:metric-definition:' || p_definition_ref_id::text, 0));
  select definition.* into v_definition from ml.metric_definition definition
   where definition.id = p_id or definition.definition_ref_id = p_definition_ref_id;
  if found then
    if v_definition.id is distinct from p_id
       or v_definition.definition_ref_id is distinct from p_definition_ref_id
       or v_definition.metric_id is distinct from p_metric_id
       or v_definition.value_kind is distinct from p_value_kind
       or v_definition.unit_id is distinct from p_unit_id
       or v_definition.allowed_enum_ids is distinct from p_allowed_enum_ids then
      raise exception 'metric definition identity was already used for different exact semantics'
        using errcode = 'unique_violation';
    end if;
  else
    insert into ml.metric_definition(
      id, definition_ref_id, metric_id, value_kind, unit_id, allowed_enum_ids
    ) values (
      p_id, p_definition_ref_id, p_metric_id, p_value_kind, p_unit_id, p_allowed_enum_ids
    ) returning * into strict v_definition;
  end if;
  perform ml.append_registry_registration(
    'metric_definition', v_definition.id, v_organization_id, v_action_id
  );
  return query select v_definition.id, v_action_id;
end
$$;

create function ml.register_metric_segment_action(
  p_id uuid,
  p_segment_ref_id uuid,
  p_run_lineage_id uuid,
  p_ordinal integer,
  p_first_sequence bigint,
  p_last_sequence bigint,
  p_event_count bigint,
  p_event_manifest text[],
  p_event_manifest_sha256 text,
  p_metadata_sha256 text
) returns table (id uuid, action_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, core, registry, ml, public
as $$
declare
  v_organization_id uuid := core.current_organization();
  v_action_id uuid;
  v_expected jsonb;
  v_segment ml.metric_segment%rowtype;
  v_run_ref_id uuid;
  v_actual_manifest text[];
  v_manifest_json text;
  v_computed_manifest_sha256 text;
  v_metadata_json text;
  v_computed_metadata_sha256 text;
begin
  v_expected := jsonb_build_object(
    'segmentId', p_id::text, 'segmentRefId', p_segment_ref_id::text,
    'runLineageId', p_run_lineage_id::text, 'schemaVersion', 2,
    'ordinal', p_ordinal, 'firstSequence', p_first_sequence,
    'lastSequence', p_last_sequence, 'eventCount', p_event_count,
    'eventDigests', to_jsonb(p_event_manifest),
    'eventManifestDigest', p_event_manifest_sha256, 'metadataDigest', p_metadata_sha256
  );
  v_action_id := ml.require_exact_registry_action(
    'register_ml_metric_segment', v_organization_id, v_expected
  );
  if p_ordinal <= 0 or p_first_sequence <= 0
     or p_last_sequence < p_first_sequence
     or p_event_count <> p_last_sequence - p_first_sequence + 1
     or p_ordinal > 9007199254740991 or p_first_sequence > 9007199254740991
     or p_last_sequence > 9007199254740991 or p_event_count > 9007199254740991
     or cardinality(p_event_manifest) <> p_event_count then
    raise exception 'metric segment is not one TypeScript-safe contiguous event range'
      using errcode = 'check_violation';
  end if;
  select lineage.run_ref_id into strict v_run_ref_id
    from ml.run_lineage lineage
    join ml.registry_registration lineage_registration
      on lineage_registration.record_kind = 'run_lineage'
     and lineage_registration.record_id = lineage.id
    join ml.aggregate_reference run_reference on run_reference.id = lineage.run_ref_id
    join ml.aggregate_reference segment_reference on segment_reference.id = p_segment_ref_id
    join ml.registry_registration segment_registration
      on segment_registration.record_kind = 'aggregate_reference'
     and segment_registration.record_id = segment_reference.id
    join registry.classification run_classification
      on run_classification.id = run_reference.classification_id
    join registry.classification segment_classification
      on segment_classification.id = segment_reference.classification_id
   where lineage.id = p_run_lineage_id
     and run_reference.organization_id = v_organization_id
     and segment_reference.organization_id = v_organization_id
     and segment_reference.aggregate_kind = 'segment'
     and run_classification.rank <= core.current_classification_rank()
     and segment_classification.rank <= core.current_classification_rank();
  select array_agg(event.event_sha256 order by event.sequence_no),
         '[' || string_agg(to_jsonb(event.event_sha256)::text, ',' order by event.sequence_no) || ']'
    into v_actual_manifest, v_manifest_json
    from ml.metric_event event
   where event.run_lineage_id = p_run_lineage_id
     and event.sequence_no between p_first_sequence and p_last_sequence;
  if v_actual_manifest is distinct from p_event_manifest then
    raise exception 'metric segment manifest does not match exact stored metric events'
      using errcode = 'integrity_constraint_violation';
  end if;
  v_computed_manifest_sha256 := encode(
    public.digest(convert_to(v_manifest_json, 'UTF8'), 'sha256'), 'hex'
  );
  v_metadata_json := '{'
    || '"eventCount":' || p_event_count::text
    || ',"eventDigests":' || v_manifest_json
    || ',"eventManifestDigest":' || to_jsonb(v_computed_manifest_sha256)::text
    || ',"firstSequence":' || p_first_sequence::text
    || ',"lastSequence":' || p_last_sequence::text
    || ',"ordinal":' || p_ordinal::text
    || ',"run":' || ml.canonical_aggregate_reference(v_run_ref_id)
    || ',"schemaVersion":"kf.ml.metric-segment.v2"'
    || ',"segment":' || ml.canonical_aggregate_reference(p_segment_ref_id)
    || '}';
  v_computed_metadata_sha256 := encode(
    public.digest(convert_to(v_metadata_json, 'UTF8'), 'sha256'), 'hex'
  );
  if p_event_manifest_sha256 is distinct from v_computed_manifest_sha256
     or p_metadata_sha256 is distinct from v_computed_metadata_sha256 then
    raise exception 'metric segment digests do not match exact canonical stored events and references'
      using errcode = 'integrity_constraint_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'kf:ml:metric-segment:' || p_run_lineage_id::text || ':' || p_ordinal::text, 0
  ));
  select segment.* into v_segment from ml.metric_segment segment
   where segment.id = p_id or segment.segment_ref_id = p_segment_ref_id
      or (segment.run_lineage_id = p_run_lineage_id and segment.ordinal = p_ordinal);
  if found then
    if v_segment.id is distinct from p_id
       or v_segment.segment_ref_id is distinct from p_segment_ref_id
       or v_segment.run_lineage_id is distinct from p_run_lineage_id
       or v_segment.ordinal is distinct from p_ordinal
       or v_segment.first_sequence is distinct from p_first_sequence
       or v_segment.last_sequence is distinct from p_last_sequence
       or v_segment.event_count is distinct from p_event_count
       or v_segment.schema_version is distinct from 2
       or v_segment.event_manifest is distinct from p_event_manifest
       or v_segment.event_manifest_sha256 is distinct from p_event_manifest_sha256
       or v_segment.metadata_sha256 is distinct from p_metadata_sha256 then
      raise exception 'metric segment identity was already used for different exact events'
        using errcode = 'unique_violation';
    end if;
  else
    insert into ml.metric_segment(
      id, segment_ref_id, run_lineage_id, ordinal, first_sequence, last_sequence,
      event_count, schema_version, event_manifest, event_manifest_sha256, metadata_sha256
    ) values (
      p_id, p_segment_ref_id, p_run_lineage_id, p_ordinal, p_first_sequence, p_last_sequence,
      p_event_count, 2, p_event_manifest, p_event_manifest_sha256, p_metadata_sha256
    ) returning * into strict v_segment;
  end if;
  perform ml.append_registry_registration(
    'metric_segment', v_segment.id, v_organization_id, v_action_id
  );
  return query select v_segment.id, v_action_id;
exception when no_data_found then
  raise exception 'metric segment references are unavailable or not action-registered'
    using errcode = 'insufficient_privilege';
end
$$;

revoke execute on function ml.enforce_registry_registration() from public;
revoke execute on function ml.require_exact_registry_action(text, uuid, jsonb) from public;
revoke execute on function ml.append_registry_registration(text, uuid, uuid, uuid) from public;
revoke execute on function ml.register_aggregate_reference_action(uuid, text, text, text, text, text, text)
  from public;
revoke execute on function ml.register_run_lineage_action(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid[], uuid[], uuid[], text
) from public;
revoke execute on function ml.register_metric_definition_action(
  uuid, uuid, text, text, text, text[]
) from public;
revoke execute on function ml.register_metric_segment_action(
  uuid, uuid, uuid, integer, bigint, bigint, bigint, text[], text, text
) from public;

grant execute on function ml.register_aggregate_reference_action(uuid, text, text, text, text, text, text)
  to kf_app, kf_worker;
grant execute on function ml.register_run_lineage_action(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid[], uuid[], uuid[], text
) to kf_app, kf_worker;
grant execute on function ml.register_metric_definition_action(
  uuid, uuid, text, text, text, text[]
) to kf_app, kf_worker;
grant execute on function ml.register_metric_segment_action(
  uuid, uuid, uuid, integer, bigint, bigint, bigint, text[], text, text
) to kf_app, kf_worker;

comment on table ml.registry_registration is
  'Append-only provenance binding each operational ML registry record to its exact typed action; legacy/import rows remain distinguishable until explicitly registered.';
comment on function ml.register_aggregate_reference_action(uuid, text, text, text, text, text, text) is
  'Typed non-promotional registration of one exact privacy-minimal aggregate reference. Does not allocate a governed authority identifier.';
comment on function ml.register_run_lineage_action(uuid, uuid, uuid, uuid, uuid, uuid, uuid[], uuid[], uuid[], text) is
  'Typed registration of exact ordered run-lineage references after canonical digest reconstruction.';
comment on function ml.register_metric_definition_action(uuid, uuid, text, text, text, text[]) is
  'Typed registration of a closed columnar metric definition; no free-text or payload escape hatch.';
comment on function ml.register_metric_segment_action(uuid, uuid, uuid, integer, bigint, bigint, bigint, text[], text, text) is
  'Typed registration of one immutable v2 segment after exact event-manifest and canonical metadata reconstruction.';

-- migrate:down

drop function if exists ml.register_metric_segment_action(
  uuid, uuid, uuid, integer, bigint, bigint, bigint, text[], text, text
);
drop function if exists ml.register_metric_definition_action(uuid, uuid, text, text, text, text[]);
drop function if exists ml.register_run_lineage_action(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid[], uuid[], uuid[], text
);
drop function if exists ml.register_aggregate_reference_action(uuid, text, text, text, text, text, text);
drop function if exists ml.append_registry_registration(text, uuid, uuid, uuid);
drop function if exists ml.require_exact_registry_action(text, uuid, jsonb);
drop trigger if exists registry_registration_append_only on ml.registry_registration;
drop trigger if exists registry_registration_validate on ml.registry_registration;
drop function if exists ml.enforce_registry_registration();
drop table if exists ml.registry_registration;
