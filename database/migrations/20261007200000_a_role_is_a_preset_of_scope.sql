-- migrate:up

-- ADR 0040 decision 4, KF-SAS-RQ-269 and RQ-270: a role is a composable preset of scope.
--
-- Until now `org.role` was a flat list of names and a role assignment conferred exactly one thing:
-- `read` and `act` at the assignment's scope, capped by its ceiling (ADR 0016, ADR 0027). Giving
-- an engineer "the engineering documents" meant one `grant_access` per engineer per document, and
-- nothing recorded that those grants were the same decision taken for every engineer.
--
-- Two tables say it once:
--
--   org.role_preset_grant  what holding a role in an organization grants: a capability at a scope
--                          object (the organization itself, or one object — the scope an access
--                          grant has, ADR 0016: reach through relations stays a projection
--                          concern), with an optional ceiling. One row per template.
--   org.role_inclusion     role A includes role B: whoever holds A receives B's preset as well.
--                          A directed acyclic graph per organization; the database refuses an
--                          inclusion that would close a cycle, naming it.
--
-- NOT A SECOND ACCESS MECHANISM. Nothing reads these tables but `org.effective_access_grant`, the
-- view every read surface and the dispatcher's act check already consult (ADR 0016, KF-SAS-RQ-041).
-- The view gains one source, `role_preset`: for every live, active, organization-scoped role
-- assignment, every template of every role reachable from the assigned role, with the role path by
-- which it arrived (`role_path`, a new last column), so an explanation of access can name it.
--
-- RECOMPUTED ON READ, NOT MATERIALIZED. The alternative was an act that writes `org.access_grant`
-- rows for every holder whenever a preset or an inclusion changes. Both were measured on a
-- 50 000-record organization of the multi fixture (the figures are in ADR 0016's note of
-- 2026-10-07), and materializing was rejected on three grounds, the first decisive: (1) a materialized grant and a direct grant to
-- the same person at the same scope collide on `access_grant_no_overlap`, so materializing would
-- either refuse ordinary grants or have to stop being one row per decision; (2) every preset
-- change would rewrite holders × templates rows, inside the act, and a missed holder would be a
-- silent divergence between the preset and what people can read; (3) the read costs the same,
-- because a person's coverage is enumerated once per request either way, and the recursion is
-- over the organization's inclusion edges (tens of rows), not over records.
--
-- WHAT A PRESET DOES NOT DO
--   * It does not widen the session. The session ceiling stays the person's clearance
--     (KF-SAS-RQ-038); row-level security still hides everything above it, so a template's ceiling
--     above someone's clearance admits nothing they could not already be cleared for.
--   * It does not travel with a project-scoped assignment. Only an assignment whose scope is the
--     organization projects its role's preset, so an assignment narrowed to one project confers
--     that project and nothing the role holds elsewhere.
--   * It does not confer the included role's AUTHORITY. Inclusion composes scope: holding `ceo`,
--     which includes `executive`, grants executive's preset, not the right to act as an
--     `executive` assignment (`org.holds_role` is unchanged).
--   * It is not delegation (ADR 0036). A preset reaches only the holders of a live assignment, and
--     every assignment still ends within 366 days; inclusion adds no assignment and no delegation.
--
-- Defining a template, retiring one, including a role and retiring an inclusion are institutional
-- acts (`requires: act`, ontology/action-types.yaml): attributed, audited, and refused without a
-- live `act` grant reaching the organization. The rows are never deleted; retirement is a state on
-- the row, complete or absent, as revocation is on `org.access_grant`.

create table org.role_preset_grant (
  id                     uuid primary key default uuidv7(),
  organization_id        uuid not null references org.organization (id) on delete restrict,
  role_id                text not null references org.role (id) on delete restrict,
  capability             text not null check (capability in ('read', 'act')),
  scope_object_id        uuid not null references core.object (id) on delete restrict,
  classification_ceiling text references registry.classification (id),
  reason                 text not null check (length(btrim(reason)) > 0),
  defined_by             uuid not null references org.person (id) on delete restrict,
  defined_at             timestamptz not null default now(),
  defined_by_action      uuid not null references core.action (id) on delete restrict,
  retired_at             timestamptz,
  retired_by             uuid references org.person (id) on delete restrict,
  retired_by_action      uuid references core.action (id) on delete restrict,
  retirement_reason      text,
  constraint role_preset_grant_retirement_complete check (
    (retired_at is null and retired_by is null and retired_by_action is null
      and retirement_reason is null)
    or (retired_at is not null and retired_by is not null and retired_by_action is not null
      and length(btrim(retirement_reason)) > 0)
  ),
  constraint role_preset_grant_retired_after_defined
    check (retired_at is null or retired_at >= defined_at)
);

-- One live template per role, capability and scope: a second would be the same decision twice,
-- and "why can engineers read this" would have two answers.
create unique index role_preset_grant_one_live
  on org.role_preset_grant (organization_id, role_id, capability, scope_object_id)
  where retired_at is null;
create index role_preset_grant_by_role
  on org.role_preset_grant (organization_id, role_id)
  where retired_at is null;

comment on table org.role_preset_grant is
  'A role''s preset of scope in one organization (ADR 0040, KF-SAS-RQ-269): what holding the role '
  'grants. Read only through org.effective_access_grant (source role_preset); never deleted, '
  'retired by an attributed act.';

create table org.role_inclusion (
  id                 uuid primary key default uuidv7(),
  organization_id    uuid not null references org.organization (id) on delete restrict,
  -- The including role: whoever holds it also receives the included role's preset.
  role_id            text not null references org.role (id) on delete restrict,
  included_role_id   text not null references org.role (id) on delete restrict,
  reason             text not null check (length(btrim(reason)) > 0),
  defined_by         uuid not null references org.person (id) on delete restrict,
  defined_at         timestamptz not null default now(),
  defined_by_action  uuid not null references core.action (id) on delete restrict,
  retired_at         timestamptz,
  retired_by         uuid references org.person (id) on delete restrict,
  retired_by_action  uuid references core.action (id) on delete restrict,
  retirement_reason  text,
  -- The shortest cycle, refused by a constraint; every longer one by the trigger below.
  constraint role_inclusion_not_itself check (role_id <> included_role_id),
  constraint role_inclusion_retirement_complete check (
    (retired_at is null and retired_by is null and retired_by_action is null
      and retirement_reason is null)
    or (retired_at is not null and retired_by is not null and retired_by_action is not null
      and length(btrim(retirement_reason)) > 0)
  ),
  constraint role_inclusion_retired_after_defined
    check (retired_at is null or retired_at >= defined_at)
);

create unique index role_inclusion_one_live
  on org.role_inclusion (organization_id, role_id, included_role_id)
  where retired_at is null;

comment on table org.role_inclusion is
  'Role A includes role B in one organization (ADR 0040, KF-SAS-RQ-269): a directed acyclic graph '
  'the database keeps acyclic. Composes presets only; confers no authority and no delegation.';

-- ── guards ───────────────────────────────────────────────────────────────────────────────────

-- A template's scope must be an object of the organization the template is made in, as an access
-- grant's must (org.access_grant_guard). A preset reaching into another tenant would be a
-- cross-organization grant made by a definition nobody reviewing that tenant could see.
create function org.role_preset_grant_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, org, core
as $$
declare
  v_scope_org uuid;
begin
  select o.organization_id into v_scope_org from core.object o where o.id = new.scope_object_id;
  if v_scope_org is null or v_scope_org <> new.organization_id then
    raise exception 'role preset scope % is not an object of organization %',
      new.scope_object_id, new.organization_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger role_preset_grant_guard
  before insert on org.role_preset_grant
  for each row execute function org.role_preset_grant_guard();

-- Retirement is the only change either table accepts, and only once. What a preset said, and
-- until when, stays evidence (Law 6).
create function org.role_preset_retire_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog
as $$
begin
  if old.retired_at is not null then
    raise exception '% % is already retired', tg_table_name, old.id
      using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - array['retired_at', 'retired_by', 'retired_by_action', 'retirement_reason'])
     is distinct from
     (to_jsonb(old) - array['retired_at', 'retired_by', 'retired_by_action', 'retirement_reason'])
  then
    raise exception '% % may only be retired; what it said is evidence', tg_table_name, old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger role_preset_grant_retire_only
  before update on org.role_preset_grant
  for each row execute function org.role_preset_retire_only();
create trigger role_inclusion_retire_only
  before update on org.role_inclusion
  for each row execute function org.role_preset_retire_only();

-- THE CYCLE CHECK. An inclusion A → B closes a cycle exactly when A is already reachable from B
-- through live inclusions in the same organization. The refusal names the cycle, because "this
-- would make engineer include itself through quality_director" is a fact a person can act on.
--
-- Two inclusions committed concurrently (A → B in one transaction, B → A in another) would each
-- see no cycle and together make one. So the check serializes per organization on an advisory
-- lock taken before it reads, and requires READ COMMITTED, under which the read after the lock is
-- a fresh snapshot that sees whatever the previous holder committed — the pattern the ML and
-- secure-object admissions use (20260814001300, 20260814001700). A REPEATABLE READ caller would
-- read the snapshot it began with and could miss the other half of the cycle, so it is refused.
create function org.role_inclusion_is_acyclic()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, org
as $$
declare
  v_path text[];
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'a role inclusion is checked for cycles under READ COMMITTED isolation only'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('org.role_inclusion:' || new.organization_id::text, 0));
  with recursive walk(role_id, path) as (
    select new.included_role_id, array[new.role_id, new.included_role_id]
    union all
    select i.included_role_id, w.path || i.included_role_id
      from walk w
      join org.role_inclusion i
        on i.organization_id = new.organization_id
       and i.role_id = w.role_id
       and i.retired_at is null
     where not (i.included_role_id = any (w.path[2:]))
  )
  select path into v_path from walk where role_id = new.role_id
   order by cardinality(path), path limit 1;
  if v_path is not null then
    raise exception 'role inclusion would form a cycle: %', array_to_string(v_path, ' includes ')
      using errcode = 'check_violation',
            detail = 'A role preset is a directed acyclic graph (ADR 0040, KF-SAS-RQ-269).';
  end if;
  return new;
end;
$$;

create trigger role_inclusion_is_acyclic
  before insert on org.role_inclusion
  for each row execute function org.role_inclusion_is_acyclic();

-- Every write is an attributed act (20260925011000): the same two guards every governed table the
-- application writes carries, so a row with no recorded act is refused, not merely discouraged.
create trigger zz_written_under_an_act
  before insert or update on org.role_preset_grant
  for each row execute function core.action_context_required();
create constraint trigger written_act_is_recorded
  after insert or update on org.role_preset_grant
  deferrable initially deferred
  for each row execute function core.action_context_recorded();
create trigger zz_written_under_an_act
  before insert or update on org.role_inclusion
  for each row execute function core.action_context_required();
create constraint trigger written_act_is_recorded
  after insert or update on org.role_inclusion
  deferrable initially deferred
  for each row execute function core.action_context_recorded();

-- A preset is an input of every holder's corpus: a change to one changes what they may read, so a
-- master record compiled before it cannot be shown current from the record of writes (§58,
-- 20260926110100). Both tables are noted like every other governed table.
create trigger zz_master_record_input_written
  after insert or update or delete or truncate on org.role_preset_grant
  for each statement execute function content.note_master_record_input_write();
create trigger zz_master_record_input_written
  after insert or update or delete or truncate on org.role_inclusion
  for each statement execute function content.note_master_record_input_write();

-- ── row security ─────────────────────────────────────────────────────────────────────────────

alter table org.role_preset_grant enable row level security;
alter table org.role_preset_grant force row level security;
-- A template is visible within its organization, and only where its scope object is: a reader is
-- not told that a role grants a record they cannot see, as `access_grant_scope` does for grants.
create policy role_preset_grant_read on org.role_preset_grant
  for select
  using (
    organization_id = (select core.current_organization())
    and exists (select 1 from core.object envelope where envelope.id = scope_object_id)
  );
create policy role_preset_grant_write on org.role_preset_grant
  for insert
  with check (
    organization_id = (select core.current_organization())
    and defined_by = (select core.current_actor())
    and defined_by_action = (select core.current_action_id())
    and exists (select 1 from core.object envelope where envelope.id = scope_object_id)
  );
create policy role_preset_grant_retire on org.role_preset_grant
  for update
  using (organization_id = (select core.current_organization()) and retired_at is null)
  with check (
    organization_id = (select core.current_organization())
    and retired_by = (select core.current_actor())
    and retired_by_action = (select core.current_action_id())
  );
create policy role_preset_grant_backup_read on org.role_preset_grant
  for select to kf_backup using (true);

alter table org.role_inclusion enable row level security;
alter table org.role_inclusion force row level security;
create policy role_inclusion_read on org.role_inclusion
  for select
  using (organization_id = (select core.current_organization()));
create policy role_inclusion_write on org.role_inclusion
  for insert
  with check (
    organization_id = (select core.current_organization())
    and defined_by = (select core.current_actor())
    and defined_by_action = (select core.current_action_id())
  );
create policy role_inclusion_retire on org.role_inclusion
  for update
  using (organization_id = (select core.current_organization()) and retired_at is null)
  with check (
    organization_id = (select core.current_organization())
    and retired_by = (select core.current_actor())
    and retired_by_action = (select core.current_action_id())
  );
create policy role_inclusion_backup_read on org.role_inclusion
  for select to kf_backup using (true);

grant select on org.role_preset_grant, org.role_inclusion
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert, update on org.role_preset_grant, org.role_inclusion to kf_app;

-- ── the one grant view, with presets ─────────────────────────────────────────────────────────
--
-- The four sources as 20260902000100 defined them, unchanged, and a fifth. `role_path` is new and
-- last (a view may only gain columns at its end): for a role assignment, the role; for a preset,
-- every role from the assigned one to the one whose template it is; null for the sources that are
-- not roles.
--
-- `role_reach` is every role reachable from every role through live inclusions, with the shortest
-- path (then the lowest, so the answer is deterministic in a diamond) — and every role reaching
-- itself with a path of one. It is evaluated over the organization's inclusion edges under the
-- reader's row security, which confines it to the bound organization: tens of rows, not records.
create or replace view org.effective_access_grant with (security_invoker = true) as
with recursive inclusion_walk(organization_id, root_role, role_id, path) as (
  select i.organization_id, i.role_id, i.included_role_id, array[i.role_id, i.included_role_id]
    from org.role_inclusion i
   where i.retired_at is null
  union all
  select w.organization_id, w.root_role, i.included_role_id, w.path || i.included_role_id
    from inclusion_walk w
    join org.role_inclusion i
      on i.organization_id = w.organization_id
     and i.role_id = w.role_id
     and i.retired_at is null
   -- The database refuses a cycle; this bound is the walk's own, so a cycle that somehow existed
   -- could make the view slower, never endless.
   where not (i.included_role_id = any (w.path))
     and cardinality(w.path) < 32
),
role_reach(organization_id, root_role, role_id, path) as (
  select distinct on (reach.organization_id, reach.root_role, reach.role_id)
         reach.organization_id, reach.root_role, reach.role_id, reach.path
    from (
      select p.organization_id, p.role_id, p.role_id, array[p.role_id]
        from org.role_preset_grant p
       where p.retired_at is null
      union all
      select w.organization_id, w.root_role, w.role_id, w.path from inclusion_walk w
    ) as reach(organization_id, root_role, role_id, path)
   order by reach.organization_id, reach.root_role, reach.role_id,
            cardinality(reach.path), reach.path
)
select 'access_grant'::text as source,
       g.id as source_id,
       g.organization_id,
       g.principal_kind,
       g.principal_id,
       g.capability,
       g.scope_object_id,
       null::text as scope_external_ref,
       g.classification_ceiling,
       g.valid_from,
       g.valid_to,
       g.granted_by,
       g.granted_by_action,
       g.reason,
       null::text[] as role_path
  from org.access_grant g
 where g.revoked_at is null
union all
select 'role_assignment'::text,
       ra.id,
       envelope.organization_id,
       'person'::text,
       ra.subject_id,
       capability.name,
       ra.scope_id,
       null::text,
       ra.classification_ceiling,
       ra.valid_from,
       ra.valid_to,
       ra.delegated_by,
       null::uuid,
       'role '::text || ra.role_id,
       array[ra.role_id]
  from org.role_assignment ra
  join core.object envelope on envelope.id = ra.id
  cross join (values ('read'::text), ('act'::text)) as capability(name)
 where envelope.lifecycle_state = 'active'
union all
select 'project_membership'::text,
       pm.id,
       project.organization_id,
       'person'::text,
       pm.person_id,
       'read'::text,
       pm.project_id,
       null::text,
       null::text,
       pm.valid_from,
       pm.valid_to,
       null::uuid,
       null::uuid,
       'project membership'::text,
       null::text[]
  from org.project_membership pm
  join core.object project on project.id = pm.project_id
union all
select 'capability_issue'::text,
       c.source_id,
       c.organization_id,
       'person'::text,
       c.principal_id,
       'read'::text,
       null::uuid,
       c.scope_external_ref,
       c.classification,
       c.valid_from,
       c.valid_to,
       null::uuid,
       c.granted_by_action,
       'secure object capability'::text,
       null::text[]
  from org.organization o
  cross join lateral org.secure_object_capability_grants(o.id)
    as c(source_id, organization_id, principal_id, scope_external_ref, classification,
         valid_from, valid_to, granted_by_action)
union all
-- A preset reaches a person through a live, active assignment scoped to the organization, for as
-- long as that assignment is valid (the window is the assignment's: ADR 0036's review date bounds
-- every preset grant it carries).
select 'role_preset'::text,
       preset.id,
       envelope.organization_id,
       'person'::text,
       ra.subject_id,
       preset.capability,
       preset.scope_object_id,
       null::text,
       preset.classification_ceiling,
       ra.valid_from,
       ra.valid_to,
       preset.defined_by,
       preset.defined_by_action,
       'role ' || array_to_string(reach.path, ' includes ') || ': ' || preset.reason,
       reach.path
  from org.role_assignment ra
  join core.object envelope
    on envelope.id = ra.id
   and envelope.lifecycle_state = 'active'
   and ra.scope_id = envelope.organization_id
  join role_reach reach
    on reach.organization_id = envelope.organization_id
   and reach.root_role = ra.role_id
  join org.role_preset_grant preset
    on preset.organization_id = reach.organization_id
   and preset.role_id = reach.role_id
   and preset.retired_at is null;

comment on view org.effective_access_grant is
  'Every live source of access in one shape (ADR 0016): direct grants, role assignments, project '
  'memberships, secure-object capabilities, and role presets through role inclusion (ADR 0040, '
  'source role_preset, with the role path in role_path). security_invoker: the caller''s row '
  'security applies.';

-- `updated_at` order within an organization: the dashboard's Recent record reads the newest
-- records a person may read, and without this every such read sorted the organization.
create index object_by_org_updated on core.object (organization_id, updated_at desc, id);

-- migrate:down

drop index if exists core.object_by_org_updated;

-- A view cannot lose a column in place, so the previous definition is restored whole.
drop view org.effective_access_grant;
create view org.effective_access_grant with (security_invoker = true) as
select 'access_grant'::text as source, g.id as source_id, g.organization_id, g.principal_kind,
       g.principal_id, g.capability, g.scope_object_id, null::text as scope_external_ref,
       g.classification_ceiling, g.valid_from, g.valid_to, g.granted_by, g.granted_by_action,
       g.reason
  from org.access_grant g where g.revoked_at is null
union all
select 'role_assignment'::text, ra.id, envelope.organization_id, 'person'::text, ra.subject_id,
       capability.name, ra.scope_id, null::text, ra.classification_ceiling, ra.valid_from,
       ra.valid_to, ra.delegated_by, null::uuid, 'role '::text || ra.role_id
  from org.role_assignment ra
  join core.object envelope on envelope.id = ra.id
  cross join (values ('read'::text), ('act'::text)) as capability(name)
 where envelope.lifecycle_state = 'active'
union all
select 'project_membership'::text, pm.id, project.organization_id, 'person'::text, pm.person_id,
       'read'::text, pm.project_id, null::text, null::text, pm.valid_from, pm.valid_to,
       null::uuid, null::uuid, 'project membership'::text
  from org.project_membership pm
  join core.object project on project.id = pm.project_id
union all
select 'capability_issue'::text, c.source_id, c.organization_id, 'person'::text, c.principal_id,
       'read'::text, null::uuid, c.scope_external_ref, c.classification, c.valid_from, c.valid_to,
       null::uuid, c.granted_by_action, 'secure object capability'::text
  from org.organization o
  cross join lateral org.secure_object_capability_grants(o.id)
    as c(source_id, organization_id, principal_id, scope_external_ref, classification,
         valid_from, valid_to, granted_by_action);
grant select on org.effective_access_grant to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;

drop table if exists org.role_inclusion;
drop table if exists org.role_preset_grant;
drop function if exists org.role_inclusion_is_acyclic();
drop function if exists org.role_preset_retire_only();
drop function if exists org.role_preset_grant_guard();
