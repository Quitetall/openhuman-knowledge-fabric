-- migrate:up

-- ML metric authority is a typed action, not a session GUC and not a table grant.
--
-- A metric-stream authorization and every appended event target exactly one organization
-- object. The wrappers below accept only a freshly-created, still-open dispatcher action whose
-- actor, role, request, target and complete parameters match the requested mutation. Metric
-- event bytes are independently reconstructed from stored aggregate references and the typed
-- scalar before the caller-supplied digest is accepted.

create function ml.require_exact_metric_action(
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
  if p_action_type not in ('authorize_ml_metric_stream', 'append_ml_metric_event') then
    raise exception 'ML action % has no typed-action policy', p_action_type
      using errcode = 'insufficient_privilege';
  end if;
  if v_action_id is null or v_role_setting is null then
    raise exception 'ML write requires exact open typed-action context'
      using errcode = 'insufficient_privilege';
  end if;
  begin
    v_role_id := v_role_setting::uuid;
  exception when invalid_text_representation then
    raise exception 'ML write has an invalid acting-role context'
      using errcode = 'insufficient_privilege';
  end;

  select action.* into v_action from core.action action where action.id = v_action_id;
  if not found
     or v_action.action_type is distinct from p_action_type
     or v_action.result_status is distinct from 'applied'
     or v_action.actor_id is distinct from v_actor
     or v_action.acting_role_id is distinct from v_role_id
     or v_action.request_id is distinct from v_request_id then
    raise exception 'ML write context does not match its exact recorded action, actor, role and request'
      using errcode = 'insufficient_privilege';
  end if;
  if v_action.target_ids is distinct from array[p_organization_id]::uuid[] then
    raise exception 'ML action target must be exactly owning organization %', p_organization_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_action.parameters is distinct from p_parameters then
    raise exception 'ML action parameters do not exactly match ledger semantics'
      using errcode = 'integrity_constraint_violation';
  end if;
  if not exists (
    select 1 from core.action action
     where action.id = v_action_id
       and action.xmin::text = pg_current_xact_id()::text
  ) then
    raise exception 'ML action must be applied in its creating transaction'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from core.audit_event event where event.action_id = v_action_id) then
    raise exception 'ML action effect must precede its audit event'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if core.current_organization() is distinct from p_organization_id or not exists (
    select 1
      from core.object object
      join org.organization organization on organization.id = object.id
     where object.id = p_organization_id
       and object.object_type = 'organization'
       and object.organization_id = p_organization_id
       and (select classification.rank
              from registry.classification classification
             where classification.id = object.classification)
           <= core.current_classification_rank()
  ) then
    raise exception 'ML target organization does not exist or is not visible'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from org.role_assignment assignment
     where assignment.id = v_role_id
       and assignment.subject_id = v_actor
       and assignment.scope_id = p_organization_id
       and assignment.valid_from <= v_action.effective_at
       and (assignment.valid_to is null or assignment.valid_to > v_action.effective_at)
       and (
         p_action_type = 'append_ml_metric_event'
         or assignment.role_id = 'technical_authority'
       )
  ) then
    raise exception 'ML action role is not authorized for % in the owning organization',
      p_action_type using errcode = 'insufficient_privilege';
  end if;
  return v_action_id;
end
$$;

create function ml.metric_stream_authorized(
  p_organization_id uuid,
  p_actor_id uuid,
  p_acting_role_id uuid,
  p_run_lineage_id uuid,
  p_metric_definition_id uuid
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, core, org, registry, ml
as $$
  select core.current_organization() = p_organization_id
     and exists (
       select 1
         from ml.metric_write_authorization authz
         join ml.run_lineage lineage on lineage.id = authz.run_lineage_id
         join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
         join registry.classification run_classification
           on run_classification.id = run_ref.classification_id
         join ml.metric_definition definition
           on definition.id = authz.metric_definition_id
         join ml.aggregate_reference definition_ref
           on definition_ref.id = definition.definition_ref_id
         join registry.classification definition_classification
           on definition_classification.id = definition_ref.classification_id
         join org.role_assignment assignment
           on assignment.id = authz.acting_role_id
        where authz.organization_id = p_organization_id
          and authz.actor_id = p_actor_id
          and authz.acting_role_id = p_acting_role_id
          and authz.run_lineage_id = p_run_lineage_id
          and authz.metric_definition_id = p_metric_definition_id
          and authz.metric_policy_ref_id = lineage.metric_policy_ref_id
          and run_ref.organization_id = p_organization_id
          and definition_ref.organization_id = p_organization_id
          and run_classification.rank <= core.current_classification_rank()
          and definition_classification.rank <= core.current_classification_rank()
          and assignment.subject_id = p_actor_id
          and assignment.scope_id = p_organization_id
          and assignment.valid_from <= now()
          and (assignment.valid_to is null or assignment.valid_to > now())
     )
$$;

create function ml.canonical_metric_event_sha256(
  p_run_lineage_id uuid,
  p_metric_definition_id uuid,
  p_idempotency_key text,
  p_sequence_no bigint,
  p_recorded_at timestamptz,
  p_numeric_value double precision,
  p_enum_value text,
  p_timestamp_value timestamptz
) returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, ml
as $$
declare
  v_run_ref_id uuid;
  v_run_org uuid;
  v_definition_ref_id uuid;
  v_definition_org uuid;
  v_metric_id text;
  v_value_kind text;
  v_allowed_enum_ids text[];
  v_recorded_at text;
  v_timestamp_value text;
  v_value_json text;
  v_event_json text;
begin
  if p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'
     or p_sequence_no <= 0
     or p_recorded_at is distinct from date_trunc('milliseconds', p_recorded_at)
     or num_nonnulls(p_numeric_value, p_enum_value, p_timestamp_value) <> 1 then
    raise exception 'metric event scalar shape is not canonical'
      using errcode = 'check_violation';
  end if;

  select lineage.run_ref_id, run_ref.organization_id
    into strict v_run_ref_id, v_run_org
    from ml.run_lineage lineage
    join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
   where lineage.id = p_run_lineage_id and run_ref.aggregate_kind = 'run';
  select definition.definition_ref_id, definition_ref.organization_id,
         definition.metric_id, definition.value_kind, definition.allowed_enum_ids
    into strict v_definition_ref_id, v_definition_org,
                v_metric_id, v_value_kind, v_allowed_enum_ids
    from ml.metric_definition definition
    join ml.aggregate_reference definition_ref on definition_ref.id = definition.definition_ref_id
   where definition.id = p_metric_definition_id
     and definition_ref.aggregate_kind = 'metric_definition';
  if v_run_org is distinct from v_definition_org then
    raise exception 'metric event references must belong to one organization'
      using errcode = 'check_violation';
  end if;

  case v_value_kind
    when 'number' then
      if p_numeric_value is null
         or p_numeric_value::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'numeric metric requires one finite numeric scalar'
          using errcode = 'check_violation';
      end if;
      v_value_json := '{"kind":"number","number":'
        || case
             when p_numeric_value = 0 then '0'
             -- RFC 8785 delegates number rendering to ECMAScript Number::toString:
             -- decimal in [1e-6, 1e21), scientific outside it. PostgreSQL's float8
             -- output is shortest-roundtrip too, but uses a zero-padded exponent.
             when abs(p_numeric_value) >= 1e21
               or abs(p_numeric_value) < 1e-6
               then regexp_replace(
                 p_numeric_value::text,
                 'e([+-])0+([0-9]+)$',
                 'e\1\2'
               )
             else to_jsonb(p_numeric_value)::text
           end
        || '}';
    when 'safe_enum' then
      if p_enum_value is null or not (p_enum_value = any(v_allowed_enum_ids)) then
        raise exception 'safe-enum metric scalar is not allowed by its definition'
          using errcode = 'check_violation';
      end if;
      v_value_json := '{"enumId":' || to_jsonb(p_enum_value)::text
        || ',"kind":"safe_enum"}';
    when 'timestamp' then
      if p_timestamp_value is null
         or p_timestamp_value is distinct from date_trunc('milliseconds', p_timestamp_value) then
        raise exception 'timestamp metric requires one canonical millisecond scalar'
          using errcode = 'check_violation';
      end if;
      v_timestamp_value := to_char(
        p_timestamp_value at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      );
      v_value_json := '{"kind":"timestamp","timestamp":'
        || to_jsonb(v_timestamp_value)::text || '}';
    else
      raise exception 'metric definition has unsupported value kind %', v_value_kind
        using errcode = 'check_violation';
  end case;

  v_recorded_at := to_char(
    p_recorded_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  -- RFC 8785 object keys are in UTF-16 code-unit order. Every string field below is already
  -- constrained to ASCII, and canonical_aggregate_reference emits its own fields in that order.
  v_event_json := '{'
    || '"idempotencyKey":' || to_jsonb(p_idempotency_key)::text
    || ',"metricDefinition":' || ml.canonical_aggregate_reference(v_definition_ref_id)
    || ',"metricId":' || to_jsonb(v_metric_id)::text
    || ',"recordedAt":' || to_jsonb(v_recorded_at)::text
    || ',"run":' || ml.canonical_aggregate_reference(v_run_ref_id)
    || ',"schemaVersion":"kf.ml.metric-event.v1"'
    || ',"sequence":' || p_sequence_no::text
    || ',"status":"provisional"'
    || ',"value":' || v_value_json
    || '}';
  return encode(public.digest(convert_to(v_event_json, 'UTF8'), 'sha256'), 'hex');
exception
  when no_data_found then
    raise exception 'metric event references are unavailable'
      using errcode = 'insufficient_privilege';
end
$$;

create function ml.authorize_metric_stream_action(
  p_authorized_actor_id uuid,
  p_authorized_role_id uuid,
  p_run_lineage_id uuid,
  p_metric_definition_id uuid,
  p_metric_policy_ref_id uuid,
  p_authorization_sha256 text
) returns table (id uuid, authorization_sha256 text)
language plpgsql
security definer
set search_path = pg_catalog, core, org, ml
as $$
declare
  v_organization_id uuid;
  v_action_id uuid;
  v_effective_at timestamptz;
  v_expected_parameters jsonb;
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
    'metricPolicyRefId', p_metric_policy_ref_id::text,
    'authorizationDigest', p_authorization_sha256
  );
  v_action_id := ml.require_exact_metric_action(
    'authorize_ml_metric_stream', v_organization_id, v_expected_parameters
  );
  select action.effective_at into strict v_effective_at
    from core.action action where action.id = v_action_id;
  if p_authorization_sha256 !~ '^[0-9a-f]{64}$' or not exists (
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

  insert into ml.metric_write_authorization (
    organization_id, actor_id, acting_role_id, run_lineage_id,
    metric_definition_id, metric_policy_ref_id, authorization_sha256, authorized_at
  ) values (
    v_organization_id, p_authorized_actor_id, p_authorized_role_id, p_run_lineage_id,
    p_metric_definition_id, p_metric_policy_ref_id, p_authorization_sha256, v_effective_at
  ) returning * into strict v_authorization;
  return query select v_authorization.id, v_authorization.authorization_sha256;
exception
  when no_data_found then
    raise exception 'metric-stream authorization references are unavailable'
      using errcode = 'insufficient_privilege';
end
$$;

create function ml.append_metric_event_action(
  p_run_lineage_id uuid,
  p_metric_definition_id uuid,
  p_idempotency_key text,
  p_sequence_no bigint,
  p_recorded_at timestamptz,
  p_numeric_value double precision,
  p_enum_value text,
  p_timestamp_value timestamptz,
  p_event_sha256 text
) returns table (
  id uuid,
  sequence_no bigint,
  recorded_at timestamptz,
  status text,
  event_sha256 text,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog, core, ml
as $$
declare
  v_organization_id uuid;
  v_value jsonb;
  v_expected_parameters jsonb;
  v_recomputed_sha256 text;
  v_event ml.metric_event%rowtype;
  v_replayed boolean;
begin
  select run_ref.organization_id into strict v_organization_id
    from ml.run_lineage lineage
    join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
    join ml.metric_definition definition on definition.id = p_metric_definition_id
    join ml.aggregate_reference definition_ref on definition_ref.id = definition.definition_ref_id
   where lineage.id = p_run_lineage_id
     and run_ref.organization_id = definition_ref.organization_id;
  v_value := case
    when p_numeric_value is not null
      then jsonb_build_object('kind', 'number', 'number', p_numeric_value)
    when p_enum_value is not null
      then jsonb_build_object('kind', 'safe_enum', 'enumId', p_enum_value)
    when p_timestamp_value is not null
      then jsonb_build_object(
        'kind', 'timestamp',
        'timestamp', to_char(
          p_timestamp_value at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      )
    else null
  end;
  v_expected_parameters := jsonb_build_object(
    'runLineageId', p_run_lineage_id::text,
    'metricDefinitionId', p_metric_definition_id::text,
    'idempotencyKey', p_idempotency_key,
    'sequence', p_sequence_no,
    'recordedAt', to_char(
      p_recorded_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'value', v_value,
    'eventDigest', p_event_sha256
  );
  perform ml.require_exact_metric_action(
    'append_ml_metric_event', v_organization_id, v_expected_parameters
  );
  v_recomputed_sha256 := ml.canonical_metric_event_sha256(
    p_run_lineage_id, p_metric_definition_id, p_idempotency_key, p_sequence_no,
    p_recorded_at, p_numeric_value, p_enum_value, p_timestamp_value
  );
  if p_event_sha256 !~ '^[0-9a-f]{64}$'
     or p_event_sha256 is distinct from v_recomputed_sha256 then
    raise exception 'metric event digest does not match canonical stored references and scalar'
      using errcode = 'integrity_constraint_violation';
  end if;

  perform 1 from ml.run_lineage lineage where lineage.id = p_run_lineage_id for update;
  select exists (
    select 1 from ml.metric_event event
     where event.run_lineage_id = p_run_lineage_id
       and event.idempotency_key = p_idempotency_key
  ) into v_replayed;
  select * into strict v_event from ml.append_metric_event(
    p_run_lineage_id, p_metric_definition_id, p_idempotency_key, p_sequence_no,
    p_recorded_at, p_numeric_value, p_enum_value, p_timestamp_value, p_event_sha256
  );
  return query select v_event.id, v_event.sequence_no, v_event.recorded_at,
                      v_event.status, v_event.event_sha256, v_replayed;
exception
  when no_data_found then
    raise exception 'metric event references are unavailable'
      using errcode = 'insufficient_privilege';
end
$$;

revoke execute on function ml.require_exact_metric_action(text, uuid, jsonb) from public;
revoke execute on function ml.metric_stream_authorized(uuid, uuid, uuid, uuid, uuid) from public;
revoke execute on function ml.canonical_metric_event_sha256(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz
) from public;
revoke execute on function ml.authorize_metric_stream_action(
  uuid, uuid, uuid, uuid, uuid, text
) from public;
revoke execute on function ml.append_metric_event_action(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) from public;

grant execute on function ml.metric_stream_authorized(uuid, uuid, uuid, uuid, uuid) to kf_app;
grant execute on function ml.authorize_metric_stream_action(
  uuid, uuid, uuid, uuid, uuid, text
) to kf_app;
grant execute on function ml.append_metric_event_action(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) to kf_app;

-- Retire the pre-dispatch write surfaces. Migration/restore owners retain their privileged
-- paths; ordinary application, worker and ML-controller roles do not.
revoke execute on function ml.append_metric_event(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) from kf_app, kf_worker;
revoke execute on function ml.append_metric_event_receipt(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) from kf_app, kf_worker;
revoke insert on ml.aggregate_reference, ml.run_lineage, ml.run_lineage_input,
                 ml.run_lineage_output, ml.run_lineage_parent_model,
                 ml.metric_definition, ml.metric_segment
  from kf_app, kf_worker;
revoke insert on ml.metric_write_authorization from kf_ml_promoter;

comment on function ml.append_metric_event_action(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) is
  'Typed-action-only metric append. Reconstructs kf.ml.metric-event.v1 from stored references before accepting its digest.';
comment on role kf_ml_promoter is
  'Offline KF ML controller. Writes run seals, signed promotion receipts and revocations only; metric-stream authority is a typed action.';

-- migrate:down

comment on role kf_ml_promoter is
  'Offline KF ML controller. Writes metric authorizations, run seals, promotion receipts, and revocations only.';

grant insert on ml.metric_write_authorization to kf_ml_promoter;
grant insert on ml.aggregate_reference, ml.run_lineage, ml.run_lineage_input,
                ml.run_lineage_output, ml.run_lineage_parent_model,
                ml.metric_definition, ml.metric_segment
  to kf_app, kf_worker;
grant execute on function ml.append_metric_event(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) to kf_app, kf_worker;
grant execute on function ml.append_metric_event_receipt(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) to kf_app, kf_worker;

drop function if exists ml.append_metric_event_action(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
);
drop function if exists ml.authorize_metric_stream_action(uuid, uuid, uuid, uuid, uuid, text);
drop function if exists ml.canonical_metric_event_sha256(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz
);
drop function if exists ml.metric_stream_authorized(uuid, uuid, uuid, uuid, uuid);
drop function if exists ml.require_exact_metric_action(text, uuid, jsonb);
