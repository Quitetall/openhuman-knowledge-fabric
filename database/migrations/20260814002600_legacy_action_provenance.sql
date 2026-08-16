-- migrate:up

-- Migration 019 froze its pre-semantic cohort while its ALTER TABLE lock excluded
-- concurrent writers. Migration 02550 recovers early development installs only from the
-- matching PostgreSQL transaction identity. Never infer this provenance from digest
-- equality here: a later application action could otherwise impersonate migration history.
do $$
begin
  if to_regclass('core.action_migration019_legacy') is null then
    raise exception
      'migration 019 provenance is absent; refusing to infer its cohort from action digests'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

create trigger action_migration019_legacy_append_only
  before update or delete or truncate on core.action_migration019_legacy
  for each statement execute function core.refuse_mutation();

alter table core.action_migration019_legacy enable row level security;
alter table core.action_migration019_legacy force row level security;

create policy action_migration019_legacy_read_scoped
  on core.action_migration019_legacy
  for select
  using (
    exists (
      select 1
        from core.action action
        join lateral unnest(action.target_ids) target(id) on true
        join core.object object on object.id = target.id
       where action.id = action_id
    )
  );

create policy action_migration019_legacy_read_auditor
  on core.action_migration019_legacy
  for select to kf_auditor
  using (true);

create policy action_migration019_legacy_read_backup
  on core.action_migration019_legacy
  for select to kf_backup
  using (true);

drop policy if exists action_migration019_legacy_read_migrator
  on core.action_migration019_legacy;
create policy action_migration019_legacy_read_migrator
  on core.action_migration019_legacy
  for select to kf_migrator
  using (true);

create policy action_migration019_legacy_restore
  on core.action_migration019_legacy
  for insert to kf_migrator
  with check (true);

revoke all on core.action_migration019_legacy from public, kf_app, kf_worker, kf_checkpoint,
  kf_migrator, kf_readonly, kf_auditor, kf_backup;
grant select on core.action_migration019_legacy to kf_app, kf_readonly, kf_auditor;
grant select, insert on core.action_migration019_legacy to kf_migrator;
grant select on core.action_migration019_legacy to kf_backup;

comment on table core.action_migration019_legacy is
  'Migration-owned allowlist of actions whose request digests were backfilled by migration 019. Application roles cannot add rows.';

-- migrate:down

drop trigger if exists action_migration019_legacy_append_only
  on core.action_migration019_legacy;
drop policy if exists action_migration019_legacy_restore
  on core.action_migration019_legacy;
drop policy if exists action_migration019_legacy_read_backup
  on core.action_migration019_legacy;
drop policy if exists action_migration019_legacy_read_migrator
  on core.action_migration019_legacy;
drop policy if exists action_migration019_legacy_read_auditor
  on core.action_migration019_legacy;
drop policy if exists action_migration019_legacy_read_scoped
  on core.action_migration019_legacy;
alter table core.action_migration019_legacy disable row level security;
alter table core.action_migration019_legacy no force row level security;
revoke all on core.action_migration019_legacy from public, kf_app, kf_worker, kf_checkpoint,
  kf_migrator, kf_readonly, kf_auditor, kf_backup;
comment on table core.action_migration019_legacy is
  'Exact action cohort rewritten by migration 019, captured in-transaction or recovered from its matching PostgreSQL transaction identity.';
