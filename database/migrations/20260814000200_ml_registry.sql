-- migrate:up

-- Privacy-minimal ML lineage and promotion authority.
--
-- PostgreSQL stores only organization-scoped, typed opaque aggregate identity, revision,
-- digest, classification, and policy. Metric payloads are deliberately columnar and typed:
-- there is no JSON/text escape hatch in which a path, subject, session, sample, label, or
-- free-text note can hide.

do $$
begin
  if not exists (select from pg_roles where rolname = 'kf_ml_promoter') then
    create role kf_ml_promoter nologin;
  end if;
end
$$;

create schema if not exists ml;

-- This role is introduced after the base schema grants were applied, so it needs the
-- cross-schema privileges used by its access context and authorization validation explicitly.
grant usage on schema core, org, registry to kf_ml_promoter;
grant select on org.role_assignment, registry.classification to kf_ml_promoter;
grant usage on schema ml
  to kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;
grant create on schema ml to kf_migrator;
grant execute on function core.set_access_context(uuid, text) to kf_ml_promoter;

create function ml.refuse_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'ml.% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    using errcode = 'insufficient_privilege',
          hint = 'Corrections are additive: append a replacement, receipt, or revocation.';
end
$$;

-- Every external aggregate carries its organization and semantic kind alongside its opaque
-- integrity/governance fields. The UUID is an internal relational key only.
create table ml.aggregate_reference (
  id                uuid primary key default uuidv7(),
  organization_id   uuid not null,
  aggregate_kind    text not null check (aggregate_kind in (
    'run', 'code', 'recipe', 'environment', 'metric_policy', 'input', 'output',
    'parent_model', 'metric_definition', 'segment', 'candidate', 'evidence'
  )),
  authority_id      text not null
    check (authority_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'),
  revision_id       text not null
    check (revision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'),
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  classification_id text not null references registry.classification (id) on delete restrict,
  policy_id         text not null check (policy_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  unique (organization_id, authority_id, revision_id)
);

create index aggregate_reference_by_org_kind
  on ml.aggregate_reference (organization_id, aggregate_kind);

create table ml.run_lineage (
  id                uuid primary key default uuidv7(),
  run_ref_id        uuid not null unique references ml.aggregate_reference (id) on delete restrict,
  code_ref_id       uuid not null references ml.aggregate_reference (id) on delete restrict,
  recipe_ref_id     uuid not null references ml.aggregate_reference (id) on delete restrict,
  environment_ref_id uuid not null references ml.aggregate_reference (id) on delete restrict,
  metric_policy_ref_id uuid not null references ml.aggregate_reference (id) on delete restrict,
  lineage_sha256    text not null unique check (lineage_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at       timestamptz not null default now()
);

create table ml.run_lineage_input (
  run_lineage_id    uuid not null references ml.run_lineage (id) on delete restrict,
  ordinal           integer not null check (ordinal > 0),
  aggregate_ref_id  uuid not null references ml.aggregate_reference (id) on delete restrict,
  primary key (run_lineage_id, ordinal),
  unique (run_lineage_id, aggregate_ref_id)
);

create table ml.run_lineage_output (
  run_lineage_id    uuid not null references ml.run_lineage (id) on delete restrict,
  ordinal           integer not null check (ordinal > 0),
  aggregate_ref_id  uuid not null references ml.aggregate_reference (id) on delete restrict,
  primary key (run_lineage_id, ordinal),
  unique (run_lineage_id, aggregate_ref_id)
);

create table ml.run_lineage_parent_model (
  run_lineage_id    uuid not null references ml.run_lineage (id) on delete restrict,
  ordinal           integer not null check (ordinal > 0),
  aggregate_ref_id  uuid not null references ml.aggregate_reference (id) on delete restrict,
  primary key (run_lineage_id, ordinal),
  unique (run_lineage_id, aggregate_ref_id)
);

create function ml.enforce_run_lineage_references() returns trigger
language plpgsql
as $$
declare
  v_run_org uuid; v_code_org uuid; v_recipe_org uuid; v_environment_org uuid;
  v_policy_org uuid; v_run_kind text; v_code_kind text; v_recipe_kind text;
  v_environment_kind text; v_policy_kind text;
begin
  select organization_id, aggregate_kind into v_run_org, v_run_kind
    from ml.aggregate_reference where id = new.run_ref_id;
  select organization_id, aggregate_kind into v_code_org, v_code_kind
    from ml.aggregate_reference where id = new.code_ref_id;
  select organization_id, aggregate_kind into v_recipe_org, v_recipe_kind
    from ml.aggregate_reference where id = new.recipe_ref_id;
  select organization_id, aggregate_kind into v_environment_org, v_environment_kind
    from ml.aggregate_reference where id = new.environment_ref_id;
  select organization_id, aggregate_kind into v_policy_org, v_policy_kind
    from ml.aggregate_reference where id = new.metric_policy_ref_id;

  if v_run_kind <> 'run' or v_code_kind <> 'code' or v_recipe_kind <> 'recipe'
     or v_environment_kind <> 'environment' or v_policy_kind <> 'metric_policy' then
    raise exception 'run lineage references have incorrect aggregate kinds'
      using errcode = 'check_violation';
  end if;
  if v_run_org is distinct from v_code_org or v_run_org is distinct from v_recipe_org
     or v_run_org is distinct from v_environment_org or v_run_org is distinct from v_policy_org then
    raise exception 'run lineage references must belong to one organization'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger run_lineage_reference_validate
  before insert on ml.run_lineage
  for each row execute function ml.enforce_run_lineage_references();

create function ml.enforce_run_lineage_member() returns trigger
language plpgsql
as $$
declare
  v_run_org uuid; v_reference_org uuid; v_reference_kind text;
begin
  perform 1 from ml.run_lineage where id = new.run_lineage_id for update;
  if exists (select 1 from ml.run_seal where run_lineage_id = new.run_lineage_id) then
    raise exception 'sealed run lineage cannot accept new members'
      using errcode = 'check_violation';
  end if;
  select r.organization_id into v_run_org
    from ml.run_lineage l
    join ml.aggregate_reference r on r.id = l.run_ref_id
   where l.id = new.run_lineage_id;
  select organization_id, aggregate_kind into v_reference_org, v_reference_kind
    from ml.aggregate_reference where id = new.aggregate_ref_id;

  if v_run_org is distinct from v_reference_org then
    raise exception 'run lineage member must belong to the run organization'
      using errcode = 'check_violation';
  end if;
  if TG_TABLE_NAME = 'run_lineage_input' and v_reference_kind <> 'input'
     or TG_TABLE_NAME = 'run_lineage_output' and v_reference_kind not in ('output', 'candidate')
     or TG_TABLE_NAME = 'run_lineage_parent_model' and v_reference_kind <> 'parent_model' then
    raise exception 'ml.% received aggregate kind %', TG_TABLE_NAME, v_reference_kind
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger run_lineage_input_reference_validate
  before insert on ml.run_lineage_input
  for each row execute function ml.enforce_run_lineage_member();
create trigger run_lineage_output_reference_validate
  before insert on ml.run_lineage_output
  for each row execute function ml.enforce_run_lineage_member();
create trigger run_lineage_parent_model_reference_validate
  before insert on ml.run_lineage_parent_model
  for each row execute function ml.enforce_run_lineage_member();

create table ml.metric_definition (
  id                uuid primary key default uuidv7(),
  definition_ref_id uuid not null unique
    references ml.aggregate_reference (id) on delete restrict,
  metric_id         text not null check (metric_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  value_kind        text not null check (value_kind in ('number', 'safe_enum', 'timestamp')),
  unit_id           text check (unit_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  allowed_enum_ids  text[] not null default '{}',
  unique (metric_id, definition_ref_id),
  constraint metric_definition_shape check (
    (value_kind = 'number' and unit_id is not null and cardinality(allowed_enum_ids) = 0)
    or (value_kind = 'safe_enum' and unit_id is null and cardinality(allowed_enum_ids) > 0)
    or (value_kind = 'timestamp' and unit_id is null and cardinality(allowed_enum_ids) = 0)
  )
);

create function ml.enforce_metric_definition() returns trigger
language plpgsql
as $$
declare v_value text; v_reference_kind text;
begin
  select aggregate_kind into v_reference_kind
    from ml.aggregate_reference where id = new.definition_ref_id;
  if v_reference_kind <> 'metric_definition' then
    raise exception 'metric definition requires a metric_definition aggregate reference'
      using errcode = 'check_violation';
  end if;
  if cardinality(new.allowed_enum_ids) <> cardinality(
    array(select distinct value from unnest(new.allowed_enum_ids) value)
  ) then
    raise exception 'metric definition % repeats an enum identifier', new.metric_id
      using errcode = 'check_violation';
  end if;
  foreach v_value in array new.allowed_enum_ids loop
    if v_value !~ '^[a-z][a-z0-9._:-]{0,127}$' then
      raise exception 'metric definition % has unsafe enum identifier %', new.metric_id, v_value
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end
$$;

create trigger metric_definition_validate
  before insert on ml.metric_definition
  for each row execute function ml.enforce_metric_definition();

-- Metric writers receive authority for one exact immutable tuple. Visibility of the run or
-- definition is intentionally insufficient: an authenticated caller must be named here with
-- the live role assignment, lineage, definition, and policy it is allowed to append under.
create table ml.metric_write_authorization (
  id                     uuid primary key default uuidv7(),
  organization_id        uuid not null references org.organization (id) on delete restrict,
  actor_id               uuid not null references org.person (id) on delete restrict,
  acting_role_id         uuid not null references org.role_assignment (id) on delete restrict,
  run_lineage_id         uuid not null references ml.run_lineage (id) on delete restrict,
  metric_definition_id   uuid not null references ml.metric_definition (id) on delete restrict,
  metric_policy_ref_id   uuid not null references ml.aggregate_reference (id) on delete restrict,
  authorization_sha256   text not null unique
    check (authorization_sha256 ~ '^[0-9a-f]{64}$'),
  authorized_at          timestamptz not null,
  unique (
    actor_id, acting_role_id, run_lineage_id, metric_definition_id, metric_policy_ref_id
  )
);

create function ml.enforce_metric_write_authorization() returns trigger
language plpgsql
as $$
declare
  v_role_actor uuid;
  v_run_org uuid;
  v_definition_org uuid;
  v_run_policy uuid;
  v_policy_org uuid;
  v_policy_kind text;
begin
  select subject_id into v_role_actor
    from org.role_assignment where id = new.acting_role_id;
  select run_ref.organization_id, lineage.metric_policy_ref_id
    into v_run_org, v_run_policy
    from ml.run_lineage lineage
    join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
   where lineage.id = new.run_lineage_id;
  select definition_ref.organization_id into v_definition_org
    from ml.metric_definition definition
    join ml.aggregate_reference definition_ref on definition_ref.id = definition.definition_ref_id
   where definition.id = new.metric_definition_id;
  select organization_id, aggregate_kind into v_policy_org, v_policy_kind
    from ml.aggregate_reference where id = new.metric_policy_ref_id;

  if v_role_actor is distinct from new.actor_id then
    raise exception 'metric write authorization role does not belong to its actor'
      using errcode = 'check_violation';
  end if;
  if v_run_policy is distinct from new.metric_policy_ref_id
     or v_policy_kind is distinct from 'metric_policy' then
    raise exception 'metric write authorization does not name the run metric policy'
      using errcode = 'check_violation';
  end if;
  if new.organization_id is distinct from v_run_org
     or new.organization_id is distinct from v_definition_org
     or new.organization_id is distinct from v_policy_org then
    raise exception 'metric write authorization references must belong to one organization'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger metric_write_authorization_validate
  before insert on ml.metric_write_authorization
  for each row execute function ml.enforce_metric_write_authorization();

create table ml.metric_event (
  id                   uuid primary key default uuidv7(),
  run_lineage_id       uuid not null references ml.run_lineage (id) on delete restrict,
  metric_definition_id uuid not null references ml.metric_definition (id) on delete restrict,
  metric_write_authorization_id uuid not null
    references ml.metric_write_authorization (id) on delete restrict,
  idempotency_key      text not null
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'),
  sequence_no          bigint not null check (sequence_no > 0),
  recorded_at          timestamptz not null,
  numeric_value        double precision,
  enum_value           text,
  timestamp_value      timestamptz,
  event_sha256         text not null unique check (event_sha256 ~ '^[0-9a-f]{64}$'),
  status               text not null default 'provisional' check (status = 'provisional'),
  unique (run_lineage_id, idempotency_key),
  unique (run_lineage_id, sequence_no),
  constraint metric_event_one_typed_value check (
    num_nonnulls(numeric_value, enum_value, timestamp_value) = 1
  ),
  constraint metric_event_finite_number check (
    numeric_value is null or numeric_value::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint metric_event_safe_enum check (
    enum_value is null or enum_value ~ '^[a-z][a-z0-9._:-]{0,127}$'
  )
);

create function ml.enforce_metric_event_type() returns trigger
language plpgsql
as $$
declare
  v_kind text;
  v_allowed text[];
  v_run_org uuid;
  v_definition_org uuid;
begin
  perform 1 from ml.run_lineage where id = new.run_lineage_id for update;
  if exists (select 1 from ml.run_seal where run_lineage_id = new.run_lineage_id) then
    raise exception 'sealed run cannot accept new metric events'
      using errcode = 'check_violation';
  end if;
  select value_kind, allowed_enum_ids into v_kind, v_allowed
    from ml.metric_definition where id = new.metric_definition_id;
  select run_ref.organization_id into v_run_org
    from ml.run_lineage lineage
    join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
   where lineage.id = new.run_lineage_id;
  select definition_ref.organization_id into v_definition_org
    from ml.metric_definition definition
    join ml.aggregate_reference definition_ref on definition_ref.id = definition.definition_ref_id
   where definition.id = new.metric_definition_id;
  if v_run_org is distinct from v_definition_org then
    raise exception 'metric event definition must belong to the run organization'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from ml.metric_write_authorization authz
     where authz.id = new.metric_write_authorization_id
       and authz.run_lineage_id = new.run_lineage_id
       and authz.metric_definition_id = new.metric_definition_id
  ) then
    raise exception 'metric event authorization does not match its lineage and definition'
      using errcode = 'check_violation';
  end if;
  if v_kind = 'number' and new.numeric_value is null
     or v_kind = 'safe_enum' and new.enum_value is null
     or v_kind = 'timestamp' and new.timestamp_value is null then
    raise exception 'metric event value does not match definition kind %', v_kind
      using errcode = 'check_violation';
  end if;
  if v_kind = 'safe_enum' and not (new.enum_value = any(v_allowed)) then
    raise exception 'enum identifier % is not allowed by the metric definition', new.enum_value
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger metric_event_validate
  before insert on ml.metric_event
  for each row execute function ml.enforce_metric_event_type();

-- Network retries call this function. An identical replay returns the first immutable row;
-- a divergent replay with the same key is rejected. Sequence collisions remain errors.
create function ml.append_metric_event(
  p_run_lineage_id uuid,
  p_metric_definition_id uuid,
  p_idempotency_key text,
  p_sequence_no bigint,
  p_recorded_at timestamptz,
  p_numeric_value double precision,
  p_enum_value text,
  p_timestamp_value timestamptz,
  p_event_sha256 text
) returns ml.metric_event
language plpgsql
security definer
set search_path = ml, pg_catalog
as $$
declare
  v_event ml.metric_event;
  v_run_org uuid; v_definition_org uuid;
  v_run_rank integer; v_definition_rank integer;
  v_policy_ref uuid;
  v_actor uuid;
  v_acting_role uuid;
  v_acting_role_setting text;
  v_authorization_id uuid;
begin
  -- The API binds these from its authenticated identity. Read them again inside the
  -- SECURITY DEFINER boundary so a caller cannot gain write authority from RLS visibility.
  v_actor := core.current_actor();
  v_acting_role_setting := nullif(current_setting('kf.acting_role', true), '');
  if v_acting_role_setting is null or core.current_action_id() is null then
    raise exception 'metric event append requires actor, role, and action transaction context'
      using errcode = 'insufficient_privilege';
  end if;
  begin
    v_acting_role := v_acting_role_setting::uuid;
  exception when invalid_text_representation then
    raise exception 'metric event append has an invalid acting role context'
      using errcode = 'insufficient_privilege';
  end;

  select run_ref.organization_id, classification.rank, lineage.metric_policy_ref_id
    into v_run_org, v_run_rank, v_policy_ref
    from ml.run_lineage lineage
    join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
    join registry.classification classification on classification.id = run_ref.classification_id
   where lineage.id = p_run_lineage_id;
  select definition_ref.organization_id, classification.rank
    into v_definition_org, v_definition_rank
    from ml.metric_definition definition
    join ml.aggregate_reference definition_ref on definition_ref.id = definition.definition_ref_id
    join registry.classification classification
      on classification.id = definition_ref.classification_id
   where definition.id = p_metric_definition_id;
  if v_run_org is null or v_definition_org is null
     or v_run_org is distinct from core.current_organization()
     or v_definition_org is distinct from core.current_organization()
     or v_run_rank > core.current_classification_rank()
     or v_definition_rank > core.current_classification_rank() then
    raise exception 'metric event references are outside the current access context'
      using errcode = 'insufficient_privilege';
  end if;
  if not org.holds_role(v_actor, v_acting_role) then
    raise exception 'metric event caller is not explicitly authorized for this lineage and metric policy'
      using errcode = 'insufficient_privilege';
  end if;
  select authz.id into v_authorization_id
    from ml.metric_write_authorization authz
   where authz.organization_id = v_run_org
     and authz.actor_id = v_actor
     and authz.acting_role_id = v_acting_role
     and authz.run_lineage_id = p_run_lineage_id
     and authz.metric_definition_id = p_metric_definition_id
     and authz.metric_policy_ref_id = v_policy_ref;
  if v_authorization_id is null then
    raise exception 'metric event caller is not explicitly authorized for this lineage and metric policy'
      using errcode = 'insufficient_privilege';
  end if;
  perform 1 from ml.run_lineage where id = p_run_lineage_id for update;

  select * into v_event from ml.metric_event
   where run_lineage_id = p_run_lineage_id and idempotency_key = p_idempotency_key;
  if found then
    if v_event.metric_definition_id <> p_metric_definition_id
       or v_event.metric_write_authorization_id <> v_authorization_id
       or v_event.sequence_no <> p_sequence_no
       or v_event.recorded_at <> p_recorded_at
       or v_event.numeric_value is distinct from p_numeric_value
       or v_event.enum_value is distinct from p_enum_value
       or v_event.timestamp_value is distinct from p_timestamp_value
       or v_event.event_sha256 <> p_event_sha256 then
      raise exception 'idempotency key % was already used for a different metric event or authorization',
        p_idempotency_key using errcode = 'unique_violation';
    end if;
    return v_event;
  end if;
  if exists (select 1 from ml.run_seal where run_lineage_id = p_run_lineage_id) then
    raise exception 'sealed run cannot accept new metric events'
      using errcode = 'check_violation';
  end if;
  insert into ml.metric_event (
    run_lineage_id, metric_definition_id, metric_write_authorization_id,
    idempotency_key, sequence_no, recorded_at,
    numeric_value, enum_value, timestamp_value, event_sha256
  ) values (
    p_run_lineage_id, p_metric_definition_id, v_authorization_id,
    p_idempotency_key, p_sequence_no, p_recorded_at,
    p_numeric_value, p_enum_value, p_timestamp_value, p_event_sha256
  )
  on conflict (run_lineage_id, idempotency_key) do nothing
  returning * into v_event;

  if found then return v_event; end if;

  select * into strict v_event from ml.metric_event
   where run_lineage_id = p_run_lineage_id and idempotency_key = p_idempotency_key;
  if v_event.metric_definition_id <> p_metric_definition_id
     or v_event.metric_write_authorization_id <> v_authorization_id
     or v_event.sequence_no <> p_sequence_no
     or v_event.recorded_at <> p_recorded_at
     or v_event.numeric_value is distinct from p_numeric_value
     or v_event.enum_value is distinct from p_enum_value
     or v_event.timestamp_value is distinct from p_timestamp_value
     or v_event.event_sha256 <> p_event_sha256 then
    raise exception 'idempotency key % was already used for a different metric event or authorization',
      p_idempotency_key using errcode = 'unique_violation';
  end if;
  return v_event;
end
$$;

-- HTTP and worker callers need to know whether they inserted or replayed without receiving
-- UPDATE privilege merely to lock an append-only lineage row. This owner-executed wrapper
-- takes the same lineage lock as append/seal, observes the key while holding it, then calls
-- the canonical append function. The returned replay bit is therefore exact under races.
create function ml.append_metric_event_receipt(
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
set search_path = ml, pg_catalog
as $$
declare
  v_event ml.metric_event;
  v_replayed boolean;
begin
  perform 1 from ml.run_lineage where ml.run_lineage.id = p_run_lineage_id for update;
  if not found then
    raise exception 'metric event run is outside the current access context'
      using errcode = 'insufficient_privilege';
  end if;
  select exists (
    select 1 from ml.metric_event
     where run_lineage_id = p_run_lineage_id and idempotency_key = p_idempotency_key
  ) into v_replayed;

  select * into strict v_event
    from ml.append_metric_event(
      p_run_lineage_id, p_metric_definition_id, p_idempotency_key, p_sequence_no,
      p_recorded_at, p_numeric_value, p_enum_value, p_timestamp_value, p_event_sha256
    );

  return query select v_event.id, v_event.sequence_no, v_event.recorded_at,
                      v_event.status, v_event.event_sha256, v_replayed;
end
$$;

create table ml.metric_segment (
  id                uuid primary key default uuidv7(),
  segment_ref_id    uuid not null unique
    references ml.aggregate_reference (id) on delete restrict,
  run_lineage_id    uuid not null references ml.run_lineage (id) on delete restrict,
  ordinal           integer not null check (ordinal > 0),
  first_sequence    bigint not null check (first_sequence > 0),
  last_sequence     bigint not null check (last_sequence >= first_sequence),
  event_count       bigint not null check (event_count > 0),
  metadata_sha256   text not null unique check (metadata_sha256 ~ '^[0-9a-f]{64}$'),
  unique (run_lineage_id, ordinal),
  unique (run_lineage_id, first_sequence),
  constraint metric_segment_contiguous_count
    check (event_count = last_sequence - first_sequence + 1)
);

create function ml.enforce_metric_segment_references() returns trigger
language plpgsql
as $$
declare v_run_org uuid; v_segment_org uuid; v_segment_kind text;
begin
  perform 1 from ml.run_lineage where id = new.run_lineage_id for update;
  if exists (select 1 from ml.run_seal where run_lineage_id = new.run_lineage_id) then
    raise exception 'sealed run cannot accept new metric segments'
      using errcode = 'check_violation';
  end if;
  select run_ref.organization_id into v_run_org
    from ml.run_lineage lineage
    join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
   where lineage.id = new.run_lineage_id;
  select organization_id, aggregate_kind into v_segment_org, v_segment_kind
    from ml.aggregate_reference where id = new.segment_ref_id;
  if v_segment_kind <> 'segment' then
    raise exception 'metric segment requires a segment aggregate reference'
      using errcode = 'check_violation';
  end if;
  if v_run_org is distinct from v_segment_org then
    raise exception 'metric segment must belong to the run organization'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger metric_segment_reference_validate
  before insert on ml.metric_segment
  for each row execute function ml.enforce_metric_segment_references();

create table ml.run_seal (
  id                      uuid primary key default uuidv7(),
  run_lineage_id          uuid not null unique references ml.run_lineage (id) on delete restrict,
  lineage_sha256          text not null check (lineage_sha256 ~ '^[0-9a-f]{64}$'),
  segment_manifest        text[] not null check (cardinality(segment_manifest) > 0),
  segment_manifest_sha256 text not null check (segment_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  event_count             bigint not null check (event_count > 0),
  sealed_at               timestamptz not null,
  signing_key_id          text not null
    check (signing_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'),
  seal_sha256             text not null unique check (seal_sha256 ~ '^[0-9a-f]{64}$'),
  signature               text not null
    check (
      signature ~ '^[A-Za-z0-9+/]{86}==$'
      and octet_length(decode(signature, 'base64')) = 64
      and replace(encode(decode(signature, 'base64'), 'base64'), E'\n', '') = signature
    ),
  recorded_at             timestamptz not null default now()
);

create function ml.enforce_run_seal() returns trigger
language plpgsql
as $$
declare
  v_lineage_sha text;
  v_segment_count bigint;
  v_event_count numeric;
  v_segment_manifest text[];
  v_manifest_canonical text;
  v_manifest_sha256 text;
begin
  perform 1 from ml.run_lineage where id = new.run_lineage_id for update;
  select lineage_sha256 into v_lineage_sha from ml.run_lineage where id = new.run_lineage_id;
  if v_lineage_sha <> new.lineage_sha256 then
    raise exception 'run seal lineage digest does not match the stored lineage'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from ml.run_lineage_input where run_lineage_id = new.run_lineage_id)
     or not exists (select 1 from ml.run_lineage_output where run_lineage_id = new.run_lineage_id) then
    raise exception 'run seal requires at least one lineage input and output'
      using errcode = 'check_violation';
  end if;
  select count(*), coalesce(sum(event_count), 0),
         array_agg(metadata_sha256 order by ordinal),
         '[' || string_agg(to_json(metadata_sha256)::text, ',' order by ordinal) || ']'
    into v_segment_count, v_event_count, v_segment_manifest, v_manifest_canonical
    from ml.metric_segment where run_lineage_id = new.run_lineage_id;
  if v_segment_count = 0 or v_event_count <> new.event_count then
    raise exception 'run seal event count does not match its metric segments'
      using errcode = 'check_violation';
  end if;
  if new.segment_manifest is distinct from v_segment_manifest then
    raise exception 'run seal segment manifest does not match the exact stored segment order'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from unnest(new.segment_manifest) digest
     where digest !~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'run seal segment manifest contains a non-SHA-256 entry'
      using errcode = 'check_violation';
  end if;
  v_manifest_sha256 := encode(
    sha256(convert_to(v_manifest_canonical, 'UTF8')),
    'hex'
  );
  if new.segment_manifest_sha256 <> v_manifest_sha256 then
    raise exception 'run seal segment manifest digest does not match the stored segment manifest'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from ml.metric_segment s
     where s.run_lineage_id = new.run_lineage_id
       and (
         (s.ordinal = 1 and s.first_sequence <> 1)
         or (s.ordinal > 1 and not exists (
           select 1 from ml.metric_segment prior
            where prior.run_lineage_id = s.run_lineage_id
              and prior.ordinal = s.ordinal - 1
              and prior.last_sequence + 1 = s.first_sequence
         ))
       )
  ) then
    raise exception 'run seal metric segments are not ordinally sequence-contiguous'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger run_seal_validate
  before insert on ml.run_seal
  for each row execute function ml.enforce_run_seal();

create table ml.promotion_receipt (
  id                                  uuid primary key default uuidv7(),
  organization_id                     uuid not null,
  alias_id                            text not null
    check (alias_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  candidate_ref_id                    uuid not null
    references ml.aggregate_reference (id) on delete restrict,
  run_seal_id                         uuid not null references ml.run_seal (id) on delete restrict,
  policy_ref_id                       uuid not null
    references ml.aggregate_reference (id) on delete restrict,
  evidence_manifest_sha256            text not null
    check (evidence_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  risk_tier                           text not null
    check (risk_tier in ('research', 'regulated', 'high_risk')),
  technical_authority_decision_ref_id uuid not null
    references ml.aggregate_reference (id) on delete restrict,
  quality_authority_decision_ref_id   uuid
    references ml.aggregate_reference (id) on delete restrict,
  promoted_at                         timestamptz not null,
  signing_key_id                      text not null
    check (signing_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'),
  receipt_sha256                      text not null unique
    check (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  signature                           text not null
    check (
      signature ~ '^[A-Za-z0-9+/]{86}==$'
      and octet_length(decode(signature, 'base64')) = 64
      and replace(encode(decode(signature, 'base64'), 'base64'), E'\n', '') = signature
    ),
  recorded_at                         timestamptz not null default now(),
  unique (organization_id, alias_id, promoted_at),
  constraint promotion_quality_authority_required check (
    risk_tier = 'research' or quality_authority_decision_ref_id is not null
  ),
  constraint promotion_authority_decisions_independent check (
    quality_authority_decision_ref_id is null
    or quality_authority_decision_ref_id <> technical_authority_decision_ref_id
  )
);

create table ml.promotion_receipt_evidence (
  promotion_receipt_id uuid not null
    references ml.promotion_receipt (id) on delete restrict,
  ordinal              integer not null check (ordinal > 0),
  evidence_ref_id      uuid not null references ml.aggregate_reference (id) on delete restrict,
  primary key (promotion_receipt_id, ordinal),
  unique (promotion_receipt_id, evidence_ref_id)
);

create function ml.enforce_promotion_receipt() returns trigger
language plpgsql
as $$
declare
  v_run_lineage uuid;
  v_policy_ref uuid;
  v_run_org uuid;
  v_candidate_org uuid; v_candidate_kind text;
  v_policy_org uuid; v_policy_kind text;
  v_technical_org uuid; v_technical_kind text;
  v_quality_org uuid; v_quality_kind text;
begin
  select s.run_lineage_id, l.metric_policy_ref_id, run_ref.organization_id
    into v_run_lineage, v_policy_ref, v_run_org
    from ml.run_seal s
    join ml.run_lineage l on l.id = s.run_lineage_id
    join ml.aggregate_reference run_ref on run_ref.id = l.run_ref_id
   where s.id = new.run_seal_id;
  select organization_id, aggregate_kind into v_candidate_org, v_candidate_kind
    from ml.aggregate_reference where id = new.candidate_ref_id;
  select organization_id, aggregate_kind into v_policy_org, v_policy_kind
    from ml.aggregate_reference where id = new.policy_ref_id;
  select organization_id, aggregate_kind into v_technical_org, v_technical_kind
    from ml.aggregate_reference where id = new.technical_authority_decision_ref_id;
  if new.quality_authority_decision_ref_id is not null then
    select organization_id, aggregate_kind into v_quality_org, v_quality_kind
      from ml.aggregate_reference where id = new.quality_authority_decision_ref_id;
  end if;
  if v_policy_ref <> new.policy_ref_id then
    raise exception 'promotion receipt policy is not the sealed run policy'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from ml.run_lineage_output
     where run_lineage_id = v_run_lineage and aggregate_ref_id = new.candidate_ref_id
  ) then
    raise exception 'promotion candidate is not a sealed run output'
      using errcode = 'check_violation';
  end if;
  if v_candidate_kind <> 'candidate' or v_policy_kind <> 'metric_policy'
     or v_technical_kind <> 'evidence'
     or (new.quality_authority_decision_ref_id is not null and v_quality_kind <> 'evidence') then
    raise exception 'promotion receipt has an incorrect aggregate reference kind'
      using errcode = 'check_violation';
  end if;
  if new.organization_id is distinct from v_run_org
     or new.organization_id is distinct from v_candidate_org
     or new.organization_id is distinct from v_policy_org
     or new.organization_id is distinct from v_technical_org
     or (new.quality_authority_decision_ref_id is not null
         and new.organization_id is distinct from v_quality_org) then
    raise exception 'promotion receipt references must belong to one organization'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger promotion_receipt_validate
  before insert on ml.promotion_receipt
  for each row execute function ml.enforce_promotion_receipt();

create function ml.enforce_promotion_evidence_reference() returns trigger
language plpgsql
as $$
declare v_receipt_org uuid; v_evidence_org uuid; v_evidence_kind text;
begin
  select organization_id into v_receipt_org
    from ml.promotion_receipt where id = new.promotion_receipt_id;
  select organization_id, aggregate_kind into v_evidence_org, v_evidence_kind
    from ml.aggregate_reference where id = new.evidence_ref_id;
  if v_evidence_kind <> 'evidence' then
    raise exception 'promotion evidence requires an evidence aggregate reference'
      using errcode = 'check_violation';
  end if;
  if v_receipt_org is distinct from v_evidence_org then
    raise exception 'promotion evidence must belong to the receipt organization'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger promotion_evidence_reference_validate
  before insert on ml.promotion_receipt_evidence
  for each row execute function ml.enforce_promotion_evidence_reference();

-- Evidence may be appended after its receipt inside the same transaction. Deferred checking
-- makes that atomic workflow possible while refusing a commit with a partial evidence set.
create function ml.enforce_complete_promotion_evidence() returns trigger
language plpgsql
as $$
declare
  v_count bigint; v_min_ordinal integer; v_max_ordinal integer;
  v_technical uuid; v_quality uuid;
begin
  select technical_authority_decision_ref_id, quality_authority_decision_ref_id
    into v_technical, v_quality
    from ml.promotion_receipt where id = new.id;
  select count(*), min(ordinal), max(ordinal)
    into v_count, v_min_ordinal, v_max_ordinal
    from ml.promotion_receipt_evidence where promotion_receipt_id = new.id;
  if v_count = 0 or v_min_ordinal <> 1 or v_max_ordinal <> v_count then
    raise exception 'promotion receipt requires a complete contiguous evidence set'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from ml.promotion_receipt_evidence
     where promotion_receipt_id = new.id and evidence_ref_id = v_technical
  ) then
    raise exception 'promotion evidence set omits the Technical Authority decision'
      using errcode = 'check_violation';
  end if;
  if v_quality is not null and not exists (
    select 1 from ml.promotion_receipt_evidence
     where promotion_receipt_id = new.id and evidence_ref_id = v_quality
  ) then
    raise exception 'promotion evidence set omits the Quality Authority decision'
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

create constraint trigger promotion_evidence_complete
  after insert on ml.promotion_receipt
  deferrable initially deferred
  for each row execute function ml.enforce_complete_promotion_evidence();

create table ml.promotion_revocation (
  id                uuid primary key default uuidv7(),
  organization_id   uuid not null,
  receipt_id        uuid not null unique references ml.promotion_receipt (id) on delete restrict,
  alias_id          text not null check (alias_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  reason_code       text not null check (reason_code in (
    'evidence_invalid', 'policy_violation', 'key_compromise', 'operator_withdrawal'
  )),
  revoked_at        timestamptz not null,
  signing_key_id    text not null
    check (signing_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'),
  revocation_sha256 text not null unique check (revocation_sha256 ~ '^[0-9a-f]{64}$'),
  signature         text not null check (
    signature ~ '^[A-Za-z0-9+/]{86}==$'
    and octet_length(decode(signature, 'base64')) = 64
    and replace(encode(decode(signature, 'base64'), 'base64'), E'\n', '') = signature
  ),
  recorded_at       timestamptz not null default now()
);

create function ml.enforce_promotion_revocation() returns trigger
language plpgsql
as $$
declare
  v_alias text;
  v_promoted_at timestamptz;
  v_organization uuid;
begin
  select organization_id, alias_id, promoted_at into v_organization, v_alias, v_promoted_at
    from ml.promotion_receipt where id = new.receipt_id;
  if v_organization is distinct from new.organization_id
     or v_alias <> new.alias_id or new.revoked_at < v_promoted_at then
    raise exception 'promotion revocation does not match or predates its receipt'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger promotion_revocation_validate
  before insert on ml.promotion_revocation
  for each row execute function ml.enforce_promotion_revocation();

-- Resolve only the latest receipt for each alias and then suppress it if revoked. Filtering
-- before ranking would silently fall back to an older model, which is never a promotion.
create view ml.governed_alias with (security_barrier = true, security_invoker = true) as
with latest as (
  select distinct on (organization_id, alias_id)
    id, organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
    evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
    quality_authority_decision_ref_id, promoted_at, signing_key_id, receipt_sha256, signature
    from ml.promotion_receipt
   order by organization_id, alias_id, promoted_at desc, receipt_sha256 desc
)
select l.organization_id, l.alias_id, l.candidate_ref_id, l.run_seal_id, l.policy_ref_id,
       l.evidence_manifest_sha256, l.risk_tier, l.technical_authority_decision_ref_id,
       l.quality_authority_decision_ref_id, l.promoted_at, l.signing_key_id,
       l.receipt_sha256, l.signature
  from latest l
  left join ml.promotion_revocation r on r.receipt_id = l.id
 where r.id is null;

-- Every ledger table is immutable. The only mutable name is the governed_alias view, whose
-- answer changes solely by appending a signed receipt or revocation.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'aggregate_reference', 'run_lineage', 'run_lineage_input', 'run_lineage_output',
    'run_lineage_parent_model', 'metric_definition', 'metric_write_authorization',
    'metric_event', 'metric_segment',
    'run_seal', 'promotion_receipt', 'promotion_receipt_evidence', 'promotion_revocation'
  ] loop
    execute format(
      'create trigger %I before update or delete or truncate on ml.%I '
      'for each statement execute function ml.refuse_mutation()',
      v_table || '_append_only', v_table
    );
  end loop;
end
$$;

-- Classification is carried by every aggregate reference. RLS on the reference is the
-- root policy; rows that compose references are visible only when all their references are.
alter table ml.aggregate_reference enable row level security;
alter table ml.aggregate_reference force row level security;
create policy aggregate_reference_privileged on ml.aggregate_reference
  for select to kf_auditor, kf_backup using (true);
create policy aggregate_reference_read on ml.aggregate_reference
  for select using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );
create policy aggregate_reference_insert on ml.aggregate_reference
  for insert with check (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );

-- The remaining tables inherit visibility through aggregate_reference. Policies are kept
-- table-specific so adding a new reference column cannot accidentally make it invisible to
-- the gate while still exposing it through a broad policy.
alter table ml.run_lineage enable row level security;
alter table ml.run_lineage force row level security;
create policy run_lineage_read on ml.run_lineage for select using (
  exists (select 1 from ml.aggregate_reference where id = run_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = code_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = recipe_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = environment_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = metric_policy_ref_id)
);
create policy run_lineage_insert on ml.run_lineage for insert with check (
  exists (select 1 from ml.aggregate_reference where id = run_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = code_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = recipe_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = environment_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = metric_policy_ref_id)
);

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'run_lineage_input', 'run_lineage_output', 'run_lineage_parent_model'
  ] loop
    execute format('alter table ml.%I enable row level security', v_table);
    execute format('alter table ml.%I force row level security', v_table);
    execute format(
      'create policy %I on ml.%I for select using ('
      'exists (select 1 from ml.run_lineage where id = run_lineage_id) and '
      'exists (select 1 from ml.aggregate_reference where id = aggregate_ref_id))',
      v_table || '_read', v_table
    );
    execute format(
      'create policy %I on ml.%I for insert with check ('
      'exists (select 1 from ml.run_lineage where id = run_lineage_id) and '
      'exists (select 1 from ml.aggregate_reference where id = aggregate_ref_id))',
      v_table || '_insert', v_table
    );
  end loop;
end
$$;

alter table ml.metric_definition enable row level security;
alter table ml.metric_definition force row level security;
create policy metric_definition_read on ml.metric_definition for select using (
  exists (select 1 from ml.aggregate_reference where id = definition_ref_id)
);
create policy metric_definition_insert on ml.metric_definition for insert with check (
  exists (select 1 from ml.aggregate_reference where id = definition_ref_id)
);

alter table ml.metric_write_authorization enable row level security;
alter table ml.metric_write_authorization force row level security;
create policy metric_write_authorization_privileged on ml.metric_write_authorization
  for select to kf_migrator, kf_ml_promoter, kf_auditor, kf_backup using (true);
create policy metric_write_authorization_insert on ml.metric_write_authorization
  for insert to kf_ml_promoter with check (
    organization_id = core.current_organization()
  );

alter table ml.metric_event enable row level security;
alter table ml.metric_event force row level security;
create policy metric_event_read on ml.metric_event for select using (
  exists (select 1 from ml.run_lineage where id = run_lineage_id)
  and exists (select 1 from ml.metric_definition where id = metric_definition_id)
);
create policy metric_event_insert on ml.metric_event for insert with check (
  exists (select 1 from ml.run_lineage where id = run_lineage_id)
  and exists (select 1 from ml.metric_definition where id = metric_definition_id)
);

alter table ml.metric_segment enable row level security;
alter table ml.metric_segment force row level security;
create policy metric_segment_read on ml.metric_segment for select using (
  exists (select 1 from ml.run_lineage where id = run_lineage_id)
  and exists (select 1 from ml.aggregate_reference where id = segment_ref_id)
);
create policy metric_segment_insert on ml.metric_segment for insert with check (
  exists (select 1 from ml.run_lineage where id = run_lineage_id)
  and exists (select 1 from ml.aggregate_reference where id = segment_ref_id)
);

alter table ml.run_seal enable row level security;
alter table ml.run_seal force row level security;
create policy run_seal_read on ml.run_seal for select using (
  exists (select 1 from ml.run_lineage where id = run_lineage_id)
);
create policy run_seal_insert on ml.run_seal for insert with check (
  exists (select 1 from ml.run_lineage where id = run_lineage_id)
);

alter table ml.promotion_receipt enable row level security;
alter table ml.promotion_receipt force row level security;
create policy promotion_receipt_read on ml.promotion_receipt for select using (
  organization_id = core.current_organization()
  and exists (select 1 from ml.aggregate_reference where id = candidate_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = policy_ref_id)
  and exists (
    select 1 from ml.aggregate_reference where id = technical_authority_decision_ref_id
  )
  and (
    quality_authority_decision_ref_id is null
    or exists (
      select 1 from ml.aggregate_reference where id = quality_authority_decision_ref_id
    )
  )
  and exists (select 1 from ml.run_seal where id = run_seal_id)
);
create policy promotion_receipt_insert on ml.promotion_receipt for insert with check (
  organization_id = core.current_organization()
  and exists (select 1 from ml.aggregate_reference where id = candidate_ref_id)
  and exists (select 1 from ml.aggregate_reference where id = policy_ref_id)
  and exists (
    select 1 from ml.aggregate_reference where id = technical_authority_decision_ref_id
  )
  and (
    quality_authority_decision_ref_id is null
    or exists (
      select 1 from ml.aggregate_reference where id = quality_authority_decision_ref_id
    )
  )
  and exists (select 1 from ml.run_seal where id = run_seal_id)
);

alter table ml.promotion_receipt_evidence enable row level security;
alter table ml.promotion_receipt_evidence force row level security;
create policy promotion_receipt_evidence_read on ml.promotion_receipt_evidence
  for select using (
    exists (select 1 from ml.promotion_receipt where id = promotion_receipt_id)
    and exists (select 1 from ml.aggregate_reference where id = evidence_ref_id)
  );
create policy promotion_receipt_evidence_insert on ml.promotion_receipt_evidence
  for insert with check (
    exists (select 1 from ml.promotion_receipt where id = promotion_receipt_id)
    and exists (select 1 from ml.aggregate_reference where id = evidence_ref_id)
  );

alter table ml.promotion_revocation enable row level security;
alter table ml.promotion_revocation force row level security;
create policy promotion_revocation_read on ml.promotion_revocation for select using (
  organization_id = core.current_organization()
  and exists (select 1 from ml.promotion_receipt where id = receipt_id)
);
create policy promotion_revocation_insert on ml.promotion_revocation for insert with check (
  organization_id = core.current_organization()
  and exists (select 1 from ml.promotion_receipt where id = receipt_id)
);

grant select on all tables in schema ml
  to kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;
revoke select on ml.metric_write_authorization from kf_app, kf_worker, kf_readonly;
grant insert on ml.aggregate_reference, ml.run_lineage, ml.run_lineage_input,
                ml.run_lineage_output, ml.run_lineage_parent_model,
                ml.metric_definition, ml.metric_segment
  to kf_app, kf_worker;
grant execute on function ml.append_metric_event_receipt(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) to kf_app, kf_worker;
grant insert on ml.run_seal, ml.promotion_receipt, ml.promotion_receipt_evidence,
                ml.promotion_revocation, ml.metric_write_authorization
  to kf_ml_promoter;
grant select on ml.governed_alias
  to kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;
grant usage, select on all sequences in schema ml to kf_app, kf_worker, kf_ml_promoter;

revoke execute on function ml.refuse_mutation() from public;
revoke execute on function ml.enforce_run_lineage_references() from public;
revoke execute on function ml.enforce_run_lineage_member() from public;
revoke execute on function ml.enforce_metric_definition() from public;
revoke execute on function ml.enforce_metric_write_authorization() from public;
revoke execute on function ml.enforce_metric_event_type() from public;
revoke execute on function ml.enforce_metric_segment_references() from public;
revoke execute on function ml.enforce_run_seal() from public;
revoke execute on function ml.enforce_promotion_receipt() from public;
revoke execute on function ml.enforce_promotion_evidence_reference() from public;
revoke execute on function ml.enforce_complete_promotion_evidence() from public;
revoke execute on function ml.enforce_promotion_revocation() from public;
revoke execute on function ml.append_metric_event(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) from public;
revoke execute on function ml.append_metric_event_receipt(
  uuid, uuid, text, bigint, timestamptz, double precision, text, timestamptz, text
) from public;

comment on schema ml is
  'Append-only privacy-minimal ML lineage, typed metrics, run seals, and signed promotions.';
comment on view ml.governed_alias is
  'Latest signed promotion only. Revoking it removes the alias instead of restoring history.';
comment on role kf_ml_promoter is
  'Offline KF ML controller. Writes metric authorizations, run seals, promotion receipts, and revocations only.';

-- migrate:down

drop schema if exists ml cascade;

-- kf_ml_promoter is retained like the other NOLOGIN group roles: it may have inherited
-- memberships or grants in another database on the same PostgreSQL cluster.
