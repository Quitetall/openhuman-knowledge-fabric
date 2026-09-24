-- migrate:up

-- ADR 0036: delegation goes one level deep, and a new assignment carries a review date.
--
-- 1. DEPTH ONE. A person who holds a role only through delegation may not delegate it again. An
--    assignment names its delegator in `delegated_by`; the database refuses it when every live
--    assignment the delegator holds of that role, at that scope, was itself delegated. "The role"
--    is (role_id, scope_id) — the pair `role_assignment_no_overlap` already treats as one grant. A
--    delegator who holds the role directly (a row with `delegated_by` null) may delegate it; one
--    who does not hold it at all is not re-delegating and is not this rule's concern (a service
--    actor's performer role is delegated by a human who may hold another role, ADR 0020).
--    `org.access_grant.delegated_from` is the same idea one level down, and §100.8 names it: a
--    grant delegated from a grant that was itself delegated is refused too.
--
-- 2. AN END WITHIN 366 DAYS. Every new role assignment and project membership has a `valid_to`,
--    at most a year and a day after its `valid_from`. Renewal is a new, attributed assignment; an
--    end date may be brought forward, never moved later or removed. Rows that exist when this
--    migration runs are grandfathered — they are not touched — and readiness reports them as "no
--    review date" (`core.readiness_assignments_without_review_date()`).
--
--    A TRIGGER, NOT A CHECK. A check constraint would refuse the grandfathered rows it cannot
--    validate on a restore, and a preservation import restores rows as they were (with user
--    triggers disabled, `packages/export/src/internal/importer/restore.ts`). Both rules hold for
--    the owner credential too: role assignments are written only there (the application has no
--    INSERT, 20260923000200), so a rule that exempted administrators would exempt every writer.
--
--    THE BOOTSTRAP EXCEPTION is the one ADR 0036 names: a write by an administrator session under
--    the bootstrap identity (`BOOTSTRAP_IDENTITY`, `apps/api/src/admin/bootstrap-organization.ts`)
--    as the sealed transaction actor. Only the local dogfood loader and the test harness write
--    assignments that way. An application session can never qualify: it is not an administrator.
--    The exception covers the end date only; depth one has none.

create function org.is_bootstrap_write() returns boolean
language sql
stable
set search_path = pg_catalog, core
as $$
  select core.session_is_administrator()
     and core.current_actor_or_null() = '01930000-0000-7000-8000-00000000b007'::uuid
$$;

revoke all on function org.is_bootstrap_write() from public;

comment on function org.is_bootstrap_write() is
  'True only for an administrator session whose sealed transaction actor is the bootstrap '
  'identity: the one writer ADR 0036 exempts from an assignment''s end date.';

-- The end-date rule, shared by both tables. SECURITY INVOKER is enough: it reads nothing.
create function org.assignment_has_a_review_date() returns trigger
language plpgsql
set search_path = pg_catalog, core, org
as $$
declare
  v_what text := case tg_table_name
                   when 'role_assignment' then 'role assignment'
                   else 'project membership'
                 end;
begin
  if tg_op = 'INSERT' then
    if org.is_bootstrap_write() then
      return new;
    end if;
    if new.valid_to is null then
      raise exception '% % has no end date', v_what, new.id
        using errcode = 'check_violation',
              detail = 'ADR 0036: every new assignment ends within 366 days of its start.',
              hint = 'Give valid_to (kf:grant-authority --valid-to; one year by default). '
                     'Renewal is a new assignment, not an open-ended one.';
    end if;
    if new.valid_to > new.valid_from + interval '366 days' then
      raise exception '% % ends more than 366 days after it starts (% to %)',
                      v_what, new.id, new.valid_from, new.valid_to
        using errcode = 'check_violation',
              detail = 'ADR 0036: a year and a day is the longest an assignment runs unreviewed.',
              hint = 'Choose an end within 366 days; renew with a new assignment before then.';
    end if;
    return new;
  end if;

  -- UPDATE. An end may be brought forward; it may not be removed, moved later, or — on a
  -- grandfathered row that has none — set further out than a new assignment could run.
  if new.valid_to is not distinct from old.valid_to or org.is_bootstrap_write() then
    return new;
  end if;
  if new.valid_to is null then
    raise exception '% % cannot lose its end date; renewal is a new assignment', v_what, old.id
      using errcode = 'check_violation';
  end if;
  if old.valid_to is not null and new.valid_to > old.valid_to then
    raise exception '% % cannot be extended; renewal is a new assignment', v_what, old.id
      using errcode = 'check_violation',
            hint = 'kf:grant-authority --renew ends this assignment and records a new one.';
  end if;
  if old.valid_to is null
     and new.valid_to > greatest(new.valid_from, now()) + interval '366 days' then
    raise exception '% % would end more than 366 days from now', v_what, old.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

revoke all on function org.assignment_has_a_review_date() from public;
-- The application still updates `valid_to` on role assignments and may write memberships; the
-- trigger runs as the invoker.
grant execute on function org.assignment_has_a_review_date(), org.is_bootstrap_write()
  to kf_app, kf_worker;

create trigger role_assignment_has_a_review_date
  before insert or update of valid_from, valid_to on org.role_assignment
  for each row execute function org.assignment_has_a_review_date();

create trigger project_membership_has_a_review_date
  before insert or update of valid_from, valid_to on org.project_membership
  for each row execute function org.assignment_has_a_review_date();

-- Depth one, for role assignments. SECURITY DEFINER: the delegator's assignments must be read
-- whatever the writer's bound ceiling, and the schema owner reads past forced row security (the
-- `schema_owner_bypasses_rls` readiness check holds that). What it reads is one boolean pair.
create function org.role_assignment_delegation_is_one_level() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_direct    boolean;
  v_delegated boolean;
begin
  if new.delegated_by is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.delegated_by is not distinct from old.delegated_by
     and new.role_id = old.role_id and new.scope_id = old.scope_id then
    return new;
  end if;
  select coalesce(bool_or(held.delegated_by is null), false),
         coalesce(bool_or(held.delegated_by is not null), false)
    into v_direct, v_delegated
    from org.role_assignment held
   where held.subject_id = new.delegated_by
     and held.role_id = new.role_id
     and held.scope_id = new.scope_id
     and held.id <> new.id
     and held.valid_from <= now()
     and (held.valid_to is null or held.valid_to > now());
  if v_delegated and not v_direct then
    raise exception 'role assignment % is delegated by a person who holds % at % only through delegation',
                    new.id, new.role_id, new.scope_id
      using errcode = 'insufficient_privilege',
            detail = 'ADR 0036: delegation goes one level deep; a delegate cannot delegate again.',
            hint = 'The person who holds the role directly must make this delegation.';
  end if;
  return new;
end
$$;

revoke all on function org.role_assignment_delegation_is_one_level() from public;

create trigger role_assignment_delegation_is_one_level
  before insert or update of delegated_by, role_id, scope_id on org.role_assignment
  for each row execute function org.role_assignment_delegation_is_one_level();

-- Depth one, for access grants: a grant delegated from a grant that was itself delegated.
create function org.access_grant_delegation_is_one_level() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, org
as $$
begin
  if new.delegated_from is null then
    return new;
  end if;
  if exists (select 1 from org.access_grant parent
              where parent.id = new.delegated_from
                and parent.delegated_from is not null) then
    raise exception 'access grant is delegated from grant %, which was itself delegated',
                    new.delegated_from
      using errcode = 'insufficient_privilege',
            detail = 'ADR 0036: delegation goes one level deep.',
            hint = 'Delegate from the grant the delegator holds directly.';
  end if;
  return new;
end
$$;

revoke all on function org.access_grant_delegation_is_one_level() from public;

create trigger access_grant_delegation_is_one_level
  before insert or update of delegated_from on org.access_grant
  for each row execute function org.access_grant_delegation_is_one_level();

-- What readiness reports: live authority with no review date, per organization. Counts only —
-- the same federated shape as `core.readiness_search_index_counts()`. Bootstrap-written role
-- assignments (the envelope's creator is the bootstrap identity) are counted apart: they are the
-- declared exception, not a finding.
create function core.readiness_assignments_without_review_date()
returns table (
  organization_id       uuid,
  role_assignments      bigint,
  bootstrap_assignments bigint,
  project_memberships   bigint
)
language sql
stable
security definer
set search_path = pg_catalog, core, org
as $$
  select organization.id,
         (select count(*)
            from org.role_assignment ra
            join core.object envelope on envelope.id = ra.id
           where envelope.organization_id = organization.id
             and envelope.created_by is distinct from '01930000-0000-7000-8000-00000000b007'::uuid
             and ra.valid_to is null and ra.valid_from <= now()),
         (select count(*)
            from org.role_assignment ra
            join core.object envelope on envelope.id = ra.id
           where envelope.organization_id = organization.id
             and envelope.created_by = '01930000-0000-7000-8000-00000000b007'::uuid
             and ra.valid_to is null and ra.valid_from <= now()),
         (select count(*)
            from org.project_membership pm
            join core.object project on project.id = pm.project_id
           where project.organization_id = organization.id
             and pm.valid_to is null and pm.valid_from <= now())
    from core.readiness_organization_ids() as organization(id)
$$;

revoke execute on function core.readiness_assignments_without_review_date() from public;
grant execute on function core.readiness_assignments_without_review_date() to kf_app, kf_worker;

comment on function core.readiness_assignments_without_review_date() is
  'Live role assignments and project memberships with no end date, per organization (ADR 0036): '
  'counts only, bootstrap-written assignments apart.';

-- migrate:down

drop function core.readiness_assignments_without_review_date();
drop trigger access_grant_delegation_is_one_level on org.access_grant;
drop function org.access_grant_delegation_is_one_level();
drop trigger role_assignment_delegation_is_one_level on org.role_assignment;
drop function org.role_assignment_delegation_is_one_level();
drop trigger project_membership_has_a_review_date on org.project_membership;
drop trigger role_assignment_has_a_review_date on org.role_assignment;
drop function org.assignment_has_a_review_date();
drop function org.is_bootstrap_write();
