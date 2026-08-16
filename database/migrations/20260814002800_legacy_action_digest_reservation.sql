-- migrate:up

-- Existing development databases may already have applied migration 019 before its exact
-- cohort capture and reserved-digest guard were consolidated. Install the same prospective
-- guard at a new migration boundary. The preserved cohort remains explicit table data.
create temporary table kf_migration028_prior_contract (
  guard_preexisting boolean not null,
  constraint_preexisting boolean not null
) on commit drop;

insert into kf_migration028_prior_contract
select
  position(
    'reserved migration-019 legacy identity'
    in pg_get_functiondef('core.assert_action_semantic_scope()'::regprocedure)
  ) > 0,
  exists (
    select 1 from pg_catalog.pg_constraint constraint_row
     where constraint_row.conrelid = 'core.action'::regclass
       and constraint_row.conname = 'action_target_ids_canonical'
  );

create or replace function core.assert_action_semantic_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
begin
  if array_ndims(new.target_ids) <> 1 or array_lower(new.target_ids, 1) <> 1 then
    raise exception 'core.action target_ids must be a one-dimensional, one-based array'
      using errcode = 'check_violation';
  end if;

  if new.request_digest is null or new.request_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'core.action request_digest must be one lowercase SHA-256 digest'
      using errcode = 'check_violation';
  end if;

  if new.request_digest = encode(
       public.digest(convert_to('kf-action-legacy-v1:' || new.id::text, 'UTF8'), 'sha256'),
       'hex'
     ) then
    raise exception 'core.action request_digest uses reserved migration-019 legacy identity'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1
      from unnest(new.target_ids) target(id)
      left join core.object object on object.id = target.id
     where object.id is null
        or object.organization_id is distinct from new.organization_id
  ) then
    raise exception 'every core.action target must belong to action organization %',
      new.organization_id
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

revoke all on function core.assert_action_semantic_scope() from public;

do $$
begin
  if exists (
    select 1 from core.action action
     where array_ndims(action.target_ids) <> 1
        or array_lower(action.target_ids, 1) <> 1
        or array_position(action.target_ids, null::uuid) is not null
  ) then
    raise exception 'existing core.action target arrays are not canonical'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
     where constraint_row.conrelid = 'core.action'::regclass
       and constraint_row.conname = 'action_target_ids_canonical'
  ) then
    alter table core.action
      add constraint action_target_ids_canonical
      check (
        array_ndims(target_ids) = 1
        and array_lower(target_ids, 1) = 1
        and array_position(target_ids, null::uuid) is null
      );
  end if;
end
$$;

-- Both directions must match: provenance cannot name a semantic action, and a reserved
-- marker cannot exist without the migration-owned row that gives it meaning.
do $$
begin
  if exists (
    select 1
      from core.action_migration019_legacy legacy
      join core.action action on action.id = legacy.action_id
     where action.request_digest <> encode(
             public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),
             'hex'
           )
  ) or exists (
    select 1
      from core.action action
     where action.request_digest = encode(
             public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),
             'hex'
           )
       and not exists (
         select 1 from core.action_migration019_legacy legacy
          where legacy.action_id = action.id
       )
  ) then
    raise exception 'legacy action digest/provenance set is inconsistent'
      using errcode = 'check_violation';
  end if;
end
$$;

do $$
declare
  v_guard_preexisting boolean;
  v_constraint_preexisting boolean;
  v_state text;
begin
  select guard_preexisting, constraint_preexisting
    into strict v_guard_preexisting, v_constraint_preexisting
    from kf_migration028_prior_contract;
  v_state := jsonb_build_object(
    'contract', 'kf-migration-028-state-v1',
    'guard_preexisting', v_guard_preexisting,
    'constraint_preexisting', v_constraint_preexisting
  )::text;
  execute format(
    'comment on function core.assert_action_semantic_scope() is %L',
    v_state
  );
end
$$;

-- migrate:down

do $migration$
declare
  v_state jsonb;
  v_guard_preexisting boolean;
  v_constraint_preexisting boolean;
begin
  begin
    v_state := obj_description(
      'core.assert_action_semantic_scope()'::regprocedure,
      'pg_proc'
    )::jsonb;
  exception when others then
    raise exception 'migration 028 rollback state is missing or malformed'
      using errcode = 'object_not_in_prerequisite_state';
  end;
  if v_state ->> 'contract' is distinct from 'kf-migration-028-state-v1'
     or v_state ->> 'guard_preexisting' is null
     or v_state ->> 'guard_preexisting' not in ('true', 'false')
     or v_state ->> 'constraint_preexisting' is null
     or v_state ->> 'constraint_preexisting' not in ('true', 'false') then
    raise exception 'migration 028 rollback state is missing or malformed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  v_guard_preexisting := (v_state ->> 'guard_preexisting')::boolean;
  v_constraint_preexisting := (v_state ->> 'constraint_preexisting')::boolean;

  if not v_guard_preexisting then
    execute $ddl$
      create or replace function core.assert_action_semantic_scope()
      returns trigger
      language plpgsql
      security definer
      set search_path = pg_catalog, core
      as $function$
      begin
        if new.request_digest is null or new.request_digest !~ '^[0-9a-f]{64}$' then
          raise exception 'core.action request_digest must be one lowercase SHA-256 digest'
            using errcode = 'check_violation';
        end if;

        if exists (
          select 1
            from unnest(new.target_ids) target(id)
            left join core.object object on object.id = target.id
           where object.id is null
              or object.organization_id is distinct from new.organization_id
        ) then
          raise exception 'every core.action target must belong to action organization %',
            new.organization_id
            using errcode = 'check_violation';
        end if;

        return new;
      end
      $function$
    $ddl$;
  end if;

  if not v_constraint_preexisting then
    alter table core.action drop constraint if exists action_target_ids_canonical;
  end if;
end
$migration$;

revoke all on function core.assert_action_semantic_scope() from public;
comment on function core.assert_action_semantic_scope() is null;
