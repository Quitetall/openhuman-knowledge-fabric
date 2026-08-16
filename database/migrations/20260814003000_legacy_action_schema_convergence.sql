-- migrate:up

-- Migrations 02550 and 028 repaired early development databases while preserving enough
-- path state for legitimate rollback. That state lived in schema comments/policy text, so a
-- fresh install and an upgraded install remained behaviorally equal but schema-different.
-- Move path-local rollback metadata into one non-authoritative row and converge public DDL.
create table core.migration030_rollback_state (
  singleton                     boolean primary key default true check (singleton),
  action_scope_comment          text not null,
  legacy_table_comment          text,
  legacy_read_scoped_qual       text not null
);

revoke all on core.migration030_rollback_state from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

insert into core.migration030_rollback_state
  (singleton, action_scope_comment, legacy_table_comment, legacy_read_scoped_qual)
select true,
       obj_description('core.assert_action_semantic_scope()'::regprocedure, 'pg_proc'),
       obj_description('core.action_migration019_legacy'::regclass, 'pg_class'),
       pg_get_expr(policy.polqual, policy.polrelid)
  from pg_policy policy
 where policy.polrelid = 'core.action_migration019_legacy'::regclass
   and policy.polname = 'action_migration019_legacy_read_scoped';

do $$
begin
  if (select count(*) from core.migration030_rollback_state) <> 1 then
    raise exception 'migration 030 cannot capture exact rollback state'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

comment on function core.assert_action_semantic_scope() is
  'Validates canonical action targets, semantic request digest syntax, reserved legacy identity, and organization scope before immutable insert.';

comment on table core.action_migration019_legacy is
  'Exact migration-019 action cohort. Membership is captured in-transaction or recovered from matching PostgreSQL transaction identity; application roles cannot add rows.';

drop policy action_migration019_legacy_read_scoped
  on core.action_migration019_legacy;
create policy action_migration019_legacy_read_scoped
  on core.action_migration019_legacy
  for select
  using (
    exists (
      select 1
        from core.action action
        join core.object object on object.id = action.target_ids[1]
       where action.id = action_id
    )
  );

comment on table core.migration030_rollback_state is
  'Path-local rollback metadata for migration 030. Derived deployment state, not Knowledge Fabric preservation authority.';

-- migrate:down

do $migration$
declare
  v_state core.migration030_rollback_state%rowtype;
begin
  select * into strict v_state from core.migration030_rollback_state where singleton;

  execute format(
    'comment on function core.assert_action_semantic_scope() is %L',
    v_state.action_scope_comment
  );
  execute format(
    'comment on table core.action_migration019_legacy is %L',
    v_state.legacy_table_comment
  );

  drop policy action_migration019_legacy_read_scoped
    on core.action_migration019_legacy;
  execute format(
    'create policy action_migration019_legacy_read_scoped '
    'on core.action_migration019_legacy for select using (%s)',
    v_state.legacy_read_scoped_qual
  );
end
$migration$;

drop table core.migration030_rollback_state;
