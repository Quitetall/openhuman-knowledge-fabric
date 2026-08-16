-- migrate:up

-- Fresh installs captured this cohort inside migration 019. Early development databases may
-- have applied an older migration-019 body before that capture existed. Recover only from
-- PostgreSQL transaction identity: dbmate records schema_migrations in the same transaction,
-- and migration 019 rewrote every pre-semantic action in that transaction. Digest equality
-- alone is insufficient provenance.
create table if not exists core.action_migration019_legacy (
  action_id          uuid primary key references core.action (id) on delete restrict,
  migration_version  bigint not null default 20260814001900
                     check (migration_version = 20260814001900)
);

-- Migration 02550 can run after an early 026 on databases where FORCE RLS is already active.
-- Recovery and preservation import both need full provenance visibility under kf_migrator;
-- this role restores authenticated history and has no UPDATE/DELETE capability.
grant select, insert on core.action_migration019_legacy to kf_migrator;
drop policy if exists action_migration019_legacy_read_migrator
  on core.action_migration019_legacy;
create policy action_migration019_legacy_read_migrator
  on core.action_migration019_legacy
  for select to kf_migrator
  using (true);

do $$
declare
  v_migration_xmin xid;
begin
  if to_regclass('public.schema_migrations') is null then
    -- Test/fresh installers may execute migration bodies directly. Migration 019 already
    -- captured the set in that path; verify equivalence without pretending transaction
    -- metadata exists.
    if exists (
      (select action.id
         from core.action action
        where action.request_digest = encode(
                public.digest(
                  convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'),
                  'sha256'
                ),
                'hex'
              )
       except
       select legacy.action_id from core.action_migration019_legacy legacy)
      union all
      (select legacy.action_id from core.action_migration019_legacy legacy
       except
       select action.id
         from core.action action
        where action.request_digest = encode(
                public.digest(
                  convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'),
                  'sha256'
                ),
                'hex'
              ))
    ) then
      raise exception
        'migration-019 provenance cannot be recovered without schema transaction metadata'
        using errcode = 'check_violation';
    end if;
    return;
  end if;

  select migration.xmin
    into strict v_migration_xmin
    from public.schema_migrations migration
   where migration.version = '20260814001900';

  if exists (
    select 1 from core.action action
     where array_ndims(action.target_ids) <> 1 or array_lower(action.target_ids, 1) <> 1
  ) then
    raise exception
      'cannot recover migration-019 provenance: historical target arrays are not canonical'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1
      from core.action action
     where action.request_digest = encode(
             public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),
             'hex'
           )
       and action.xmin <> v_migration_xmin
  ) then
    raise exception
      'cannot recover migration-019 provenance: reserved digest exists outside its transaction'
      using errcode = 'check_violation';
  end if;

  insert into core.action_migration019_legacy (action_id)
  select action.id
    from core.action action
   where action.xmin = v_migration_xmin
     and action.request_digest = encode(
           public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),
           'hex'
         )
  on conflict (action_id) do nothing;

  if exists (
    (select action.id
       from core.action action
      where action.xmin = v_migration_xmin
        and action.request_digest = encode(
              public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),
              'hex'
            )
     except
     select legacy.action_id from core.action_migration019_legacy legacy)
    union all
    (select legacy.action_id from core.action_migration019_legacy legacy
     except
     select action.id
       from core.action action
      where action.xmin = v_migration_xmin
        and action.request_digest = encode(
              public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),
              'hex'
            ))
  ) then
    raise exception 'migration-019 provenance differs from its transaction-owned action cohort'
      using errcode = 'check_violation';
  end if;
end
$$;

comment on table core.action_migration019_legacy is
  'Exact action cohort rewritten by migration 019, captured in-transaction or recovered from its matching PostgreSQL transaction identity.';

-- migrate:down

-- Provenance is owned by migration 019 and must survive rollback of this compatibility step.
select 1;
