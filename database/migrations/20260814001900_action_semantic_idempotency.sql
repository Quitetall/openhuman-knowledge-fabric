-- migrate:up

-- Bind idempotency to one organization's exact mutation semantics.
--
-- The original (action_type, idempotency_key) index prevented duplicate commits, but it
-- allowed a retry carrying different targets or parameters to replay the first result. It
-- also made otherwise-independent organizations share one global key namespace. Persist the
-- dispatcher's canonical request digest and validate that every target belongs to the named
-- organization before the immutable action row lands.

alter table core.action
  add column organization_id uuid,
  add column request_digest text;

-- Existing rows predate the semantic digest contract. Organization is recoverable from their
-- controlled targets; request omission-versus-value details are not. Give each legacy action a
-- unique explicit marker digest so no future request can silently replay it as semantically
-- equivalent.
alter table core.action disable trigger action_append_only;

-- PostgreSQL arrays can carry arbitrary lower bounds and dimensions. Preserve target order
-- while rebasing historical values to the one-dimensional, one-based action wire contract.
update core.action action
   set target_ids = (
     select array_agg(target.id order by target.ordinal)
       from unnest(action.target_ids) with ordinality target(id, ordinal)
   )
 where array_ndims(action.target_ids) <> 1
    or array_lower(action.target_ids, 1) <> 1;

update core.action action
   set organization_id = (
    select object.organization_id
      from unnest(action.target_ids) with ordinality item(id, ordinal)
      join core.object object on object.id = item.id
     order by item.ordinal
     limit 1
   );

do $$
begin
  if exists (
    select 1
      from core.action action
     where action.organization_id is null
        or exists (
          select 1
            from unnest(action.target_ids) target(id)
            left join core.object object on object.id = target.id
           where object.id is null
              or object.organization_id is distinct from action.organization_id
        )
  ) then
    raise exception
      'cannot migrate core.action: every historical target must resolve to one organization'
      using errcode = 'check_violation';
  end if;
end
$$;

update core.action
   set request_digest = encode(
     public.digest(convert_to('kf-action-legacy-v1:' || id::text, 'UTF8'), 'sha256'),
     'hex'
   );

-- Freeze the exact cohort while ALTER TABLE still excludes concurrent writers. Later
-- compatibility code must not infer legacy status from a digest an application can copy.
create table core.action_migration019_legacy (
  action_id          uuid primary key references core.action (id) on delete restrict,
  migration_version  bigint not null default 20260814001900
                     check (migration_version = 20260814001900)
);

insert into core.action_migration019_legacy (action_id)
select id from core.action;

alter table core.action enable trigger action_append_only;

alter table core.action
  alter column organization_id set not null,
  alter column request_digest set not null,
  add constraint action_organization_fk
    foreign key (organization_id) references org.organization (id)
    on delete restrict deferrable initially deferred,
  add constraint action_request_digest_sha256
    check (request_digest ~ '^[0-9a-f]{64}$'),
  add constraint action_target_ids_canonical
    check (
      array_ndims(target_ids) = 1
      and array_lower(target_ids, 1) = 1
      and array_position(target_ids, null::uuid) is null
    );

drop index core.action_idempotency;
create unique index action_idempotency
  on core.action (organization_id, action_type, idempotency_key);

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

create trigger action_semantic_scope_guard
  before insert on core.action
  for each row execute function core.assert_action_semantic_scope();

comment on column core.action.organization_id is
  'Organization-scoped idempotency and authority boundary; all target objects must match.';
comment on column core.action.request_digest is
  'SHA-256 over canonical kf-action-request-v1 mutation semantics. Transport request id and read classification are excluded.';

-- migrate:down

drop trigger if exists action_semantic_scope_guard on core.action;
drop function if exists core.assert_action_semantic_scope();
drop table if exists core.action_migration019_legacy;
drop index if exists core.action_idempotency;
create unique index action_idempotency on core.action (action_type, idempotency_key);
alter table core.action
  drop constraint if exists action_request_digest_sha256,
  drop constraint if exists action_target_ids_canonical,
  drop constraint if exists action_organization_fk,
  drop column if exists request_digest,
  drop column if exists organization_id;
