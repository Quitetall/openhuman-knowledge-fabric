-- migrate:up

-- Preserve historical opaque authorization digests as v1 records. Every authorization
-- created after this migration is a v2 claim derived by KF from its immutable action and
-- exact governed tuple; no caller-supplied digest crosses the authority boundary.
alter table ml.metric_write_authorization
  add column schema_version smallint not null default 1,
  add column action_id uuid references core.action (id) on delete restrict;

alter table ml.metric_write_authorization alter column schema_version set default 2;
alter table ml.metric_write_authorization
  add constraint metric_write_authorization_versioned_claim check (
    (schema_version = 1 and action_id is null)
    or (schema_version = 2 and action_id is not null)
  );

create function ml.canonical_metric_write_authorization_v2(
  p_action_id uuid,
  p_organization_id uuid,
  p_actor_id uuid,
  p_acting_role_id uuid,
  p_run_lineage_id uuid,
  p_metric_definition_id uuid,
  p_metric_policy_ref_id uuid,
  p_authorized_at timestamptz
) returns text
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare v_authorized_at text;
begin
  if not isfinite(p_authorized_at)
     or p_authorized_at < timestamptz '0001-01-01 00:00:00+00'
     or p_authorized_at >= timestamptz '10000-01-01 00:00:00+00'
     or p_authorized_at is distinct from date_trunc('milliseconds', p_authorized_at) then
    raise exception 'metric write authorization timestamp is outside canonical v2 domain'
      using errcode = 'invalid_parameter_value';
  end if;
  v_authorized_at := to_char(
    p_authorized_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  -- ASCII keys emitted in RFC 8785 lexical order.
  return '{'
    || '"actingRoleId":' || to_jsonb(p_acting_role_id::text)::text
    || ',"actionId":' || to_jsonb(p_action_id::text)::text
    || ',"actorId":' || to_jsonb(p_actor_id::text)::text
    || ',"authorizedAt":' || to_jsonb(v_authorized_at)::text
    || ',"metricDefinitionId":' || to_jsonb(p_metric_definition_id::text)::text
    || ',"metricPolicyRefId":' || to_jsonb(p_metric_policy_ref_id::text)::text
    || ',"organizationId":' || to_jsonb(p_organization_id::text)::text
    || ',"runLineageId":' || to_jsonb(p_run_lineage_id::text)::text
    || ',"schemaVersion":"kf.ml.metric-write-authorization.v2"'
    || '}';
end;
$$;

revoke execute on function ml.canonical_metric_write_authorization_v2(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz
) from public;

alter function ml.authorize_metric_stream_action(uuid, uuid, uuid, uuid, uuid, text)
  rename to authorize_metric_stream_action_v1_archive;
revoke execute on function ml.authorize_metric_stream_action_v1_archive(
  uuid, uuid, uuid, uuid, uuid, text
) from public, kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;

create function ml.authorize_metric_stream_action(
  p_authorized_actor_id uuid,
  p_authorized_role_id uuid,
  p_run_lineage_id uuid,
  p_metric_definition_id uuid,
  p_metric_policy_ref_id uuid
) returns table (id uuid, authorization_sha256 text)
language plpgsql
security definer
set search_path = pg_catalog, core, org, ml, public
as $$
declare
  v_organization_id uuid;
  v_action_id uuid;
  v_effective_at timestamptz;
  v_expected_parameters jsonb;
  v_claim text;
  v_authorization_sha256 text;
  v_authorization ml.metric_write_authorization%rowtype;
begin
  select run_ref.organization_id into strict v_organization_id
    from ml.run_lineage lineage
    join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
    join ml.metric_definition definition on definition.id = p_metric_definition_id
    join ml.aggregate_reference definition_ref on definition_ref.id = definition.definition_ref_id
   where lineage.id = p_run_lineage_id
     and lineage.metric_policy_ref_id = p_metric_policy_ref_id
     and run_ref.organization_id = definition_ref.organization_id;
  v_expected_parameters := jsonb_build_object(
    'authorizedActorId', p_authorized_actor_id::text,
    'authorizedRoleId', p_authorized_role_id::text,
    'runLineageId', p_run_lineage_id::text,
    'metricDefinitionId', p_metric_definition_id::text,
    'metricPolicyRefId', p_metric_policy_ref_id::text
  );
  v_action_id := ml.require_exact_metric_action(
    'authorize_ml_metric_stream', v_organization_id, v_expected_parameters
  );
  select action.effective_at into strict v_effective_at
    from core.action action where action.id = v_action_id;
  if not exists (
    select 1 from org.role_assignment assignment
     where assignment.id = p_authorized_role_id
       and assignment.subject_id = p_authorized_actor_id
       and assignment.scope_id = v_organization_id
       and assignment.valid_from <= v_effective_at
       and (assignment.valid_to is null or assignment.valid_to > v_effective_at)
  ) then
    raise exception 'metric-stream authorization does not bind one active organization role'
      using errcode = 'check_violation';
  end if;

  v_claim := ml.canonical_metric_write_authorization_v2(
    v_action_id, v_organization_id, p_authorized_actor_id, p_authorized_role_id,
    p_run_lineage_id, p_metric_definition_id, p_metric_policy_ref_id, v_effective_at
  );
  v_authorization_sha256 := encode(
    public.digest(convert_to(v_claim, 'UTF8'), 'sha256'),
    'hex'
  );
  insert into ml.metric_write_authorization (
    organization_id, actor_id, acting_role_id, run_lineage_id,
    metric_definition_id, metric_policy_ref_id, authorization_sha256, authorized_at,
    schema_version, action_id
  ) values (
    v_organization_id, p_authorized_actor_id, p_authorized_role_id, p_run_lineage_id,
    p_metric_definition_id, p_metric_policy_ref_id, v_authorization_sha256, v_effective_at,
    2, v_action_id
  ) returning * into strict v_authorization;
  return query select v_authorization.id, v_authorization.authorization_sha256;
exception
  when no_data_found then
    raise exception 'metric-stream authorization references are unavailable'
      using errcode = 'insufficient_privilege';
end;
$$;

revoke execute on function ml.authorize_metric_stream_action(uuid, uuid, uuid, uuid, uuid)
  from public;
grant execute on function ml.authorize_metric_stream_action(uuid, uuid, uuid, uuid, uuid)
  to kf_app;

comment on function ml.authorize_metric_stream_action(uuid, uuid, uuid, uuid, uuid) is
  'Typed-action-only metric authority. Derives kf.ml.metric-write-authorization.v2 bytes and SHA-256 from exact immutable action and governed tuple; accepts no caller digest.';
comment on column ml.metric_write_authorization.schema_version is
  'v1 preserves opaque historical digests; v2 digest is reconstructed from exact canonical authorization fields.';

-- v1 segments name only a range. Preserve them for historical verification, but emit v2
-- segments whose canonical metadata includes every event digest in exact sequence order.
alter table ml.metric_segment
  add column schema_version smallint not null default 1,
  add column event_manifest text[],
  add column event_manifest_sha256 text;

alter table ml.metric_segment alter column schema_version set default 2;
alter table ml.metric_segment
  add constraint metric_segment_versioned_event_manifest check (
    (
      schema_version = 1
      and event_manifest is null
      and event_manifest_sha256 is null
    ) or (
      schema_version = 2
      and cardinality(event_manifest) = event_count
      and event_manifest_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

create function ml.enforce_metric_segment_v2_event_manifest() returns trigger
language plpgsql
set search_path = pg_catalog, ml, public
as $$
declare
  v_actual_manifest text[];
  v_actual_manifest_json text;
  v_actual_count bigint;
  v_actual_first bigint;
  v_actual_last bigint;
  v_manifest_sha256 text;
  v_run_ref_id uuid;
  v_segment_json text;
  v_run_json text;
  v_metadata text;
  v_metadata_sha256 text;
begin
  if new.schema_version = 1 then
    return new;
  end if;
  if new.schema_version <> 2 then
    raise exception 'unsupported metric segment schema version %', new.schema_version
      using errcode = 'invalid_parameter_value';
  end if;
  select array_agg(event.event_sha256 order by event.sequence_no),
         '[' || string_agg(to_jsonb(event.event_sha256)::text, ',' order by event.sequence_no) || ']',
         count(*), min(event.sequence_no), max(event.sequence_no)
    into v_actual_manifest, v_actual_manifest_json, v_actual_count, v_actual_first, v_actual_last
    from ml.metric_event event
   where event.run_lineage_id = new.run_lineage_id
     and event.sequence_no between new.first_sequence and new.last_sequence;
  if v_actual_count <> new.event_count
     or v_actual_first <> new.first_sequence
     or v_actual_last <> new.last_sequence
     or new.event_manifest is distinct from v_actual_manifest then
    raise exception 'metric segment event digest manifest does not match exact stored sequence range'
      using errcode = 'integrity_constraint_violation';
  end if;
  v_manifest_sha256 := encode(
    public.digest(convert_to(v_actual_manifest_json, 'UTF8'), 'sha256'),
    'hex'
  );
  if new.event_manifest_sha256 is distinct from v_manifest_sha256 then
    raise exception 'metric segment event digest manifest SHA-256 does not match stored events'
      using errcode = 'integrity_constraint_violation';
  end if;

  select lineage.run_ref_id into strict v_run_ref_id
    from ml.run_lineage lineage where lineage.id = new.run_lineage_id;
  v_run_json := ml.canonical_aggregate_reference(v_run_ref_id);
  v_segment_json := ml.canonical_aggregate_reference(new.segment_ref_id);
  v_metadata := '{'
    || '"eventCount":' || new.event_count::text
    || ',"eventDigests":' || v_actual_manifest_json
    || ',"eventManifestDigest":' || to_jsonb(v_manifest_sha256)::text
    || ',"firstSequence":' || new.first_sequence::text
    || ',"lastSequence":' || new.last_sequence::text
    || ',"ordinal":' || new.ordinal::text
    || ',"run":' || v_run_json
    || ',"schemaVersion":"kf.ml.metric-segment.v2"'
    || ',"segment":' || v_segment_json
    || '}';
  v_metadata_sha256 := encode(
    public.digest(convert_to(v_metadata, 'UTF8'), 'sha256'),
    'hex'
  );
  if new.metadata_sha256 is distinct from v_metadata_sha256 then
    raise exception 'stored metric-segment v2 digest does not match canonical stored fields and events'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

create trigger metric_segment_v2_event_manifest_validate
  before insert on ml.metric_segment
  for each row execute function ml.enforce_metric_segment_v2_event_manifest();

revoke execute on function ml.enforce_metric_segment_v2_event_manifest() from public;

-- Run-seal v2 repeats the digest of the complete ordered event manifest in signed bytes.
alter table ml.run_seal
  add column schema_version smallint not null default 1,
  add column event_manifest_sha256 text;

alter table ml.run_seal alter column schema_version set default 2;
alter table ml.run_seal
  add constraint run_seal_versioned_event_manifest check (
    (schema_version = 1 and event_manifest_sha256 is null)
    or (
      schema_version = 2
      and event_manifest_sha256 ~ '^[0-9a-f]{64}$'
    )
  );

create function ml.enforce_run_seal_v2_event_manifest() returns trigger
language plpgsql
set search_path = pg_catalog, ml, public
as $$
declare
  v_event_manifest_json text;
  v_event_manifest_sha256 text;
  v_event_count bigint;
begin
  if new.schema_version = 1 then
    return new;
  end if;
  if new.schema_version <> 2 then
    raise exception 'unsupported run seal schema version %', new.schema_version
      using errcode = 'invalid_parameter_value';
  end if;
  if exists (
    select 1 from ml.metric_segment segment
     where segment.run_lineage_id = new.run_lineage_id
       and segment.schema_version <> 2
  ) then
    raise exception 'run seal v2 cannot include a legacy metric segment'
      using errcode = 'integrity_constraint_violation';
  end if;
  select '[' || string_agg(to_jsonb(event.event_sha256)::text, ',' order by event.sequence_no) || ']',
         count(*)
    into v_event_manifest_json, v_event_count
    from ml.metric_event event
   where event.run_lineage_id = new.run_lineage_id;
  if v_event_count <> new.event_count then
    raise exception 'run seal v2 event manifest count does not match stored events'
      using errcode = 'integrity_constraint_violation';
  end if;
  v_event_manifest_sha256 := encode(
    public.digest(convert_to(v_event_manifest_json, 'UTF8'), 'sha256'),
    'hex'
  );
  if new.event_manifest_sha256 is distinct from v_event_manifest_sha256 then
    raise exception 'run seal v2 event manifest digest does not match exact stored event order'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

create trigger run_seal_v2_event_manifest_validate
  before insert on ml.run_seal
  for each row execute function ml.enforce_run_seal_v2_event_manifest();

revoke execute on function ml.enforce_run_seal_v2_event_manifest() from public;

alter function ml.append_signed_run_seal(uuid, uuid, text, timestamptz, text, text, text)
  rename to append_signed_run_seal_v1_archive;
revoke execute on function ml.append_signed_run_seal_v1_archive(
  uuid, uuid, text, timestamptz, text, text, text
) from public, kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;

create function ml.append_signed_run_seal(
  p_organization_id uuid,
  p_run_lineage_id uuid,
  p_workload_identity_ref text,
  p_sealed_at timestamptz,
  p_signing_key_id text,
  p_seal_sha256 text,
  p_signature text
) returns table (
  id uuid,
  seal_sha256 text,
  signing_key_registry_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, ml, public
as $$
declare
  v_lineage ml.run_lineage%rowtype;
  v_run_ref ml.aggregate_reference%rowtype;
  v_code_ref ml.aggregate_reference%rowtype;
  v_recipe_ref ml.aggregate_reference%rowtype;
  v_environment_ref ml.aggregate_reference%rowtype;
  v_policy_ref ml.aggregate_reference%rowtype;
  v_run_json text;
  v_lineage_json text;
  v_recomputed_lineage_sha256 text;
  v_inputs_json text;
  v_outputs_json text;
  v_parent_models_json text;
  v_input_count bigint;
  v_output_count bigint;
  v_parent_model_count bigint;
  v_input_min integer;
  v_input_max integer;
  v_output_min integer;
  v_output_max integer;
  v_parent_model_min integer;
  v_parent_model_max integer;
  v_inputs_valid boolean;
  v_outputs_valid boolean;
  v_parent_models_valid boolean;
  v_segment record;
  v_segment_manifest text[] := '{}'::text[];
  v_segment_manifest_json text := '[';
  v_segment_count bigint := 0;
  v_segment_event_manifest text[];
  v_segment_event_manifest_json text;
  v_segment_event_count bigint;
  v_segment_event_first bigint;
  v_segment_event_last bigint;
  v_segment_event_manifest_sha256 text;
  v_segment_json text;
  v_recomputed_segment_sha256 text;
  v_global_event_manifest text[] := '{}'::text[];
  v_global_event_manifest_json text;
  v_global_event_manifest_sha256 text;
  v_expected_ordinal integer := 1;
  v_expected_sequence bigint := 1;
  v_event_count bigint := 0;
  v_stored_event_count bigint;
  v_first_event_sequence bigint;
  v_last_event_sequence bigint;
  v_segment_manifest_sha256 text;
  v_sealed_at text;
  v_unsigned_seal text;
  v_recomputed_seal_sha256 text;
  v_signing_key_registry_id uuid;
  v_public_key_spki_der bytea;
  v_seal ml.run_seal%rowtype;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'run-seal append requires READ COMMITTED for a fresh post-lock authority read'
      using errcode = 'feature_not_supported';
  end if;
  if core.current_organization() is distinct from p_organization_id then
    raise exception 'run seal organization is outside current access context'
      using errcode = 'insufficient_privilege';
  end if;
  if p_workload_identity_ref is null
     or p_workload_identity_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'
     or p_signing_key_id is null
     or p_signing_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'
     or p_seal_sha256 is null
     or p_seal_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'run seal contains an unsafe workload, key, or digest'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_sealed_at is null
     or not isfinite(p_sealed_at)
     or p_sealed_at < timestamptz '0001-01-01 00:00:00+00'
     or p_sealed_at >= timestamptz '10000-01-01 00:00:00+00'
     or p_sealed_at is distinct from date_trunc('milliseconds', p_sealed_at) then
    raise exception 'run seal timestamp must be a finite four-digit-year canonical millisecond instant'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Freeze lineage, events, and segments at one row lock shared with all append triggers.
  select lineage.* into strict v_lineage
    from ml.run_lineage lineage
   where lineage.id = p_run_lineage_id
   for update;
  select reference.* into strict v_run_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.run_ref_id;
  select reference.* into strict v_code_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.code_ref_id;
  select reference.* into strict v_recipe_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.recipe_ref_id;
  select reference.* into strict v_environment_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.environment_ref_id;
  select reference.* into strict v_policy_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.metric_policy_ref_id;
  if v_run_ref.organization_id is distinct from p_organization_id
     or v_code_ref.organization_id is distinct from p_organization_id
     or v_recipe_ref.organization_id is distinct from p_organization_id
     or v_environment_ref.organization_id is distinct from p_organization_id
     or v_policy_ref.organization_id is distinct from p_organization_id
     or v_run_ref.aggregate_kind <> 'run'
     or v_code_ref.aggregate_kind <> 'code'
     or v_recipe_ref.aggregate_kind <> 'recipe'
     or v_environment_ref.aggregate_kind <> 'environment'
     or v_policy_ref.aggregate_kind <> 'metric_policy' then
    raise exception 'run seal lineage contains a cross-organization or incorrectly typed reference'
      using errcode = 'check_violation';
  end if;

  select count(*), min(member.ordinal), max(member.ordinal),
         coalesce(
           '[' || string_agg(ml.canonical_aggregate_reference(member.aggregate_ref_id), ','
                             order by member.ordinal) || ']',
           '[]'
         ),
         bool_and(reference.organization_id = p_organization_id
                  and reference.aggregate_kind = 'input')
    into v_input_count, v_input_min, v_input_max, v_inputs_json, v_inputs_valid
    from ml.run_lineage_input member
    join ml.aggregate_reference reference on reference.id = member.aggregate_ref_id
   where member.run_lineage_id = p_run_lineage_id;
  select count(*), min(member.ordinal), max(member.ordinal),
         coalesce(
           '[' || string_agg(ml.canonical_aggregate_reference(member.aggregate_ref_id), ','
                             order by member.ordinal) || ']',
           '[]'
         ),
         bool_and(reference.organization_id = p_organization_id
                  and reference.aggregate_kind in ('output', 'candidate'))
    into v_output_count, v_output_min, v_output_max, v_outputs_json, v_outputs_valid
    from ml.run_lineage_output member
    join ml.aggregate_reference reference on reference.id = member.aggregate_ref_id
   where member.run_lineage_id = p_run_lineage_id;
  select count(*), min(member.ordinal), max(member.ordinal),
         coalesce(
           '[' || string_agg(ml.canonical_aggregate_reference(member.aggregate_ref_id), ','
                             order by member.ordinal) || ']',
           '[]'
         ),
         bool_and(reference.organization_id = p_organization_id
                  and reference.aggregate_kind = 'parent_model')
    into v_parent_model_count, v_parent_model_min, v_parent_model_max,
         v_parent_models_json, v_parent_models_valid
    from ml.run_lineage_parent_model member
    join ml.aggregate_reference reference on reference.id = member.aggregate_ref_id
   where member.run_lineage_id = p_run_lineage_id;
  if v_input_count = 0 or v_input_min <> 1 or v_input_max::bigint <> v_input_count
     or v_inputs_valid is not true
     or v_output_count = 0 or v_output_min <> 1 or v_output_max::bigint <> v_output_count
     or v_outputs_valid is not true
     or (
       v_parent_model_count > 0
       and (
         v_parent_model_min <> 1
         or v_parent_model_max::bigint <> v_parent_model_count
         or v_parent_models_valid is not true
       )
     ) then
    raise exception 'run seal requires complete, contiguous, correctly typed lineage members'
      using errcode = 'check_violation';
  end if;

  v_run_json := ml.canonical_aggregate_reference(v_run_ref.id);
  v_lineage_json := '{'
    || '"code":' || ml.canonical_aggregate_reference(v_code_ref.id)
    || ',"environment":' || ml.canonical_aggregate_reference(v_environment_ref.id)
    || ',"inputs":' || v_inputs_json
    || ',"metricPolicy":' || ml.canonical_aggregate_reference(v_policy_ref.id)
    || ',"outputs":' || v_outputs_json
    || ',"parentModels":' || v_parent_models_json
    || ',"recipe":' || ml.canonical_aggregate_reference(v_recipe_ref.id)
    || ',"run":' || v_run_json
    || ',"schemaVersion":"kf.ml.run-lineage.v1"'
    || '}';
  v_recomputed_lineage_sha256 := encode(
    public.digest(convert_to(v_lineage_json, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_recomputed_lineage_sha256 is distinct from v_lineage.lineage_sha256 then
    raise exception 'stored run-lineage digest does not match canonical stored members'
      using errcode = 'integrity_constraint_violation';
  end if;

  for v_segment in
    select segment.ordinal, segment.first_sequence, segment.last_sequence,
           segment.event_count, segment.schema_version, segment.event_manifest,
           segment.event_manifest_sha256, segment.metadata_sha256,
           reference.organization_id as segment_organization_id,
           reference.aggregate_kind as segment_kind,
           ml.canonical_aggregate_reference(reference.id) as segment_json
      from ml.metric_segment segment
      join ml.aggregate_reference reference on reference.id = segment.segment_ref_id
     where segment.run_lineage_id = p_run_lineage_id
     order by segment.ordinal
  loop
    if v_segment.schema_version <> 2
       or v_segment.ordinal <> v_expected_ordinal
       or v_segment.first_sequence <> v_expected_sequence
       or v_segment.last_sequence < v_segment.first_sequence
       or v_segment.event_count <> v_segment.last_sequence - v_segment.first_sequence + 1
       or v_segment.segment_organization_id is distinct from p_organization_id
       or v_segment.segment_kind <> 'segment'
       or v_segment.ordinal > 9007199254740991
       or v_segment.first_sequence > 9007199254740991
       or v_segment.last_sequence > 9007199254740991
       or v_segment.event_count > 9007199254740991 then
      raise exception 'run seal requires exact TypeScript-safe v2 metric segments'
        using errcode = 'check_violation';
    end if;

    select array_agg(event.event_sha256 order by event.sequence_no),
           '[' || string_agg(to_jsonb(event.event_sha256)::text, ',' order by event.sequence_no) || ']',
           count(*), min(event.sequence_no), max(event.sequence_no)
      into v_segment_event_manifest, v_segment_event_manifest_json, v_segment_event_count,
           v_segment_event_first, v_segment_event_last
      from ml.metric_event event
     where event.run_lineage_id = p_run_lineage_id
       and event.sequence_no between v_segment.first_sequence and v_segment.last_sequence;
    if v_segment_event_count <> v_segment.event_count
       or v_segment_event_first <> v_segment.first_sequence
       or v_segment_event_last <> v_segment.last_sequence
       or v_segment.event_manifest is distinct from v_segment_event_manifest then
      raise exception 'run seal segment event digest manifest does not match exact stored events'
        using errcode = 'integrity_constraint_violation';
    end if;
    v_segment_event_manifest_sha256 := encode(
      public.digest(convert_to(v_segment_event_manifest_json, 'UTF8'), 'sha256'),
      'hex'
    );
    if v_segment.event_manifest_sha256 is distinct from v_segment_event_manifest_sha256 then
      raise exception 'run seal segment event digest manifest SHA-256 does not match stored events'
        using errcode = 'integrity_constraint_violation';
    end if;

    v_segment_json := '{'
      || '"eventCount":' || v_segment.event_count::text
      || ',"eventDigests":' || v_segment_event_manifest_json
      || ',"eventManifestDigest":' || to_jsonb(v_segment_event_manifest_sha256)::text
      || ',"firstSequence":' || v_segment.first_sequence::text
      || ',"lastSequence":' || v_segment.last_sequence::text
      || ',"ordinal":' || v_segment.ordinal::text
      || ',"run":' || v_run_json
      || ',"schemaVersion":"kf.ml.metric-segment.v2"'
      || ',"segment":' || v_segment.segment_json
      || '}';
    v_recomputed_segment_sha256 := encode(
      public.digest(convert_to(v_segment_json, 'UTF8'), 'sha256'),
      'hex'
    );
    if v_recomputed_segment_sha256 is distinct from v_segment.metadata_sha256 then
      raise exception 'stored metric-segment v2 digest does not match canonical stored fields and events'
        using errcode = 'integrity_constraint_violation';
    end if;

    if v_segment_count > 0 then
      v_segment_manifest_json := v_segment_manifest_json || ',';
    end if;
    v_segment_manifest_json :=
      v_segment_manifest_json || to_jsonb(v_segment.metadata_sha256)::text;
    v_segment_manifest := array_append(v_segment_manifest, v_segment.metadata_sha256);
    v_global_event_manifest := v_global_event_manifest || v_segment_event_manifest;
    v_segment_count := v_segment_count + 1;
    v_event_count := v_event_count + v_segment.event_count;
    if v_event_count > 9007199254740991 then
      raise exception 'run seal event count exceeds the TypeScript safe-integer contract'
        using errcode = 'numeric_value_out_of_range';
    end if;
    v_expected_ordinal := v_expected_ordinal + 1;
    v_expected_sequence := v_segment.last_sequence + 1;
  end loop;
  v_segment_manifest_json := v_segment_manifest_json || ']';
  if v_segment_count = 0 then
    raise exception 'run seal requires at least one metric segment'
      using errcode = 'check_violation';
  end if;

  select count(*), min(event.sequence_no), max(event.sequence_no)
    into v_stored_event_count, v_first_event_sequence, v_last_event_sequence
    from ml.metric_event event
   where event.run_lineage_id = p_run_lineage_id;
  if v_stored_event_count <> v_event_count
     or v_first_event_sequence <> 1
     or v_last_event_sequence <> v_event_count then
    raise exception 'run seal metric segments do not exactly cover stored metric events without gaps'
      using errcode = 'check_violation';
  end if;

  select '[' || string_agg(to_jsonb(event_digest)::text, ',' order by ordinal) || ']'
    into v_global_event_manifest_json
    from unnest(v_global_event_manifest) with ordinality manifest(event_digest, ordinal);
  v_global_event_manifest_sha256 := encode(
    public.digest(convert_to(v_global_event_manifest_json, 'UTF8'), 'sha256'),
    'hex'
  );
  v_segment_manifest_sha256 := encode(
    public.digest(convert_to(v_segment_manifest_json, 'UTF8'), 'sha256'),
    'hex'
  );
  v_sealed_at := to_char(
    p_sealed_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_unsigned_seal := '{'
    || '"eventCount":' || v_event_count::text
    || ',"eventManifestDigest":' || to_jsonb(v_global_event_manifest_sha256)::text
    || ',"lineageDigest":' || to_jsonb(v_recomputed_lineage_sha256)::text
    || ',"run":' || v_run_json
    || ',"schemaVersion":"kf.ml.run-seal.v2"'
    || ',"sealedAt":' || to_jsonb(v_sealed_at)::text
    || ',"segmentDigests":' || v_segment_manifest_json
    || ',"signingKeyId":' || to_jsonb(p_signing_key_id)::text
    || '}';
  v_recomputed_seal_sha256 := encode(
    public.digest(convert_to(v_unsigned_seal, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_recomputed_seal_sha256 is distinct from p_seal_sha256 then
    raise exception 'run seal digest does not match canonical stored lineage, segments, and events'
      using errcode = 'integrity_constraint_violation';
  end if;

  select active.signing_key_registry_id, active.public_key_spki_der
    into strict v_signing_key_registry_id, v_public_key_spki_der
    from ml.active_run_seal_signing_public_key(
      p_organization_id, p_workload_identity_ref, p_signing_key_id, p_sealed_at
    ) active;
  if ml.verify_run_seal_signature(v_public_key_spki_der, v_unsigned_seal, p_signature)
     is not true then
    raise exception 'run seal Ed25519 signature verification failed'
      using errcode = 'integrity_constraint_violation';
  end if;

  insert into ml.run_seal (
    run_lineage_id, lineage_sha256, segment_manifest, segment_manifest_sha256,
    event_count, sealed_at, signing_key_id, signing_key_registry_id, seal_sha256,
    signature, schema_version, event_manifest_sha256
  ) values (
    p_run_lineage_id, v_recomputed_lineage_sha256, v_segment_manifest,
    v_segment_manifest_sha256, v_event_count, p_sealed_at, p_signing_key_id,
    v_signing_key_registry_id, p_seal_sha256, p_signature, 2,
    v_global_event_manifest_sha256
  ) returning ml.run_seal.* into v_seal;

  return query select v_seal.id, v_seal.seal_sha256, v_seal.signing_key_registry_id;
end;
$$;

revoke execute on function ml.append_signed_run_seal(
  uuid, uuid, text, timestamptz, text, text, text
) from public, kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant execute on function ml.append_signed_run_seal(
  uuid, uuid, text, timestamptz, text, text, text
) to kf_ml_promoter;

comment on function ml.append_signed_run_seal(
  uuid, uuid, text, timestamptz, text, text, text
) is
  'Only promoter run-seal append seam. Reconstructs v2 segment and seal bytes from exact ordered stored metric-event digests before Ed25519 verification.';
comment on column ml.metric_segment.event_manifest is
  'v2 exact event_sha256 values in ascending sequence order; included in metric-segment metadata digest.';
comment on column ml.run_seal.event_manifest_sha256 is
  'v2 SHA-256 of all included event digests in exact run sequence order; included in signed seal bytes.';

-- migrate:down

do $$
begin
  if exists (select 1 from ml.run_seal where schema_version = 2)
     or exists (select 1 from ml.metric_segment where schema_version = 2)
     or exists (select 1 from ml.metric_write_authorization where schema_version = 2) then
    raise exception 'cannot remove ML v2 provenance while v2 authority records exist'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end;
$$;

revoke execute on function ml.append_signed_run_seal(
  uuid, uuid, text, timestamptz, text, text, text
) from public, kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;
drop function ml.append_signed_run_seal(uuid, uuid, text, timestamptz, text, text, text);
alter function ml.append_signed_run_seal_v1_archive(
  uuid, uuid, text, timestamptz, text, text, text
) rename to append_signed_run_seal;
grant execute on function ml.append_signed_run_seal(
  uuid, uuid, text, timestamptz, text, text, text
) to kf_ml_promoter;

drop trigger run_seal_v2_event_manifest_validate on ml.run_seal;
drop function ml.enforce_run_seal_v2_event_manifest();
alter table ml.run_seal drop constraint run_seal_versioned_event_manifest;
alter table ml.run_seal drop column event_manifest_sha256, drop column schema_version;

drop trigger metric_segment_v2_event_manifest_validate on ml.metric_segment;
drop function ml.enforce_metric_segment_v2_event_manifest();
alter table ml.metric_segment drop constraint metric_segment_versioned_event_manifest;
alter table ml.metric_segment
  drop column event_manifest_sha256,
  drop column event_manifest,
  drop column schema_version;

revoke execute on function ml.authorize_metric_stream_action(uuid, uuid, uuid, uuid, uuid)
  from public, kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;
drop function ml.authorize_metric_stream_action(uuid, uuid, uuid, uuid, uuid);
alter function ml.authorize_metric_stream_action_v1_archive(
  uuid, uuid, uuid, uuid, uuid, text
) rename to authorize_metric_stream_action;
grant execute on function ml.authorize_metric_stream_action(
  uuid, uuid, uuid, uuid, uuid, text
) to kf_app;

drop function ml.canonical_metric_write_authorization_v2(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, timestamptz
);
alter table ml.metric_write_authorization
  drop constraint metric_write_authorization_versioned_claim;
alter table ml.metric_write_authorization drop column action_id, drop column schema_version;
