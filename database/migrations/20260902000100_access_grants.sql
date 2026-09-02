-- migrate:up

-- ADR 0016. Access is a grant: an effective-dated, revocable record that names WHO may do
-- WHAT to WHICH object, who decided, and the recorded act that decided it. Until now a person's
-- corpus was "every object in the organization at or below the clearance" — need-to-know
-- existed only as subtraction (`content.person_entitlement_exclusion`). Role assignments,
-- project memberships and secure-object capabilities each already said "this person may reach
-- this thing", in three shapes that nothing read as one. This migration adds the positive
-- primitive and presents all four sources through one view, so the permitted set and an
-- access explanation read the same facts.
--
-- `org.role_assignment` is NOT replaced by a view: it is a first-class `core.object` type and
-- the foreign-key target of `ml.promotion_decision.approver_role_id` and
-- `ml.metric_stream.acting_role_id`. The compatibility direction is therefore the other way
-- round — the existing tables stay authoritative for what they are, and the unified surface is
-- the view over them.

create table org.access_grant (
  id                     uuid primary key default uuidv7(),
  organization_id        uuid not null references org.organization (id) on delete restrict,
  -- A person, or a role assignment (so that authority can be attached to a role rather than
  -- re-granted to each holder). Both are core objects.
  principal_kind         text not null check (principal_kind in ('person', 'role_assignment')),
  principal_id           uuid not null references core.object (id) on delete restrict,
  -- `read`: the scope object enters the principal's permitted set. `act`: the principal may be
  -- named as acting authority on it. A grant carries exactly one; two capabilities are two
  -- grants with two reasons.
  capability             text not null check (capability in ('read', 'act')),
  -- The organization itself as scope means every object in it (today's behaviour for an
  -- organization-scoped role). Any other object means that object, and nothing transitive:
  -- reach through relations is a projection concern, not an access one.
  scope_object_id        uuid not null references core.object (id) on delete restrict,
  -- Optional cap on what this grant lets the principal see at the scope. Never raises the
  -- ceiling: person clearance and row-level security still bound everything.
  classification_ceiling text references registry.classification (id),
  valid_from             timestamptz not null default now(),
  valid_to               timestamptz,
  granted_by             uuid not null references org.person (id) on delete restrict,
  granted_at             timestamptz not null default now(),
  granted_by_action      uuid not null references core.action (id) on delete restrict,
  delegated_from         uuid references org.access_grant (id) on delete restrict,
  reason                 text not null check (length(btrim(reason)) > 0),
  -- Revocation is a state on the row, not a delete: the grant remains evidence of what was
  -- permitted between valid_from and revoked_at.
  revoked_at             timestamptz,
  revoked_by             uuid references org.person (id) on delete restrict,
  revoked_by_action      uuid references core.action (id) on delete restrict,
  revocation_reason      text,
  constraint access_grant_interval_ordered
    check (valid_to is null or valid_to > valid_from),
  constraint access_grant_revocation_complete check (
    (revoked_at is null and revoked_by is null and revoked_by_action is null
      and revocation_reason is null)
    or (revoked_at is not null and revoked_by is not null and revoked_by_action is not null
      and length(btrim(revocation_reason)) > 0)
  ),
  constraint access_grant_revoked_after_granted
    check (revoked_at is null or revoked_at >= granted_at),
  unique (id, organization_id)
);

-- Two live grants of the same capability to the same principal at the same scope over
-- overlapping windows would make "was this person allowed on that date, and by whose
-- decision" ambiguous. A revoked grant no longer counts, so it does not block a fresh one.
alter table org.access_grant
  add constraint access_grant_no_overlap
  exclude using gist (
    principal_kind with =,
    principal_id with =,
    capability with =,
    scope_object_id with =,
    tstzrange(valid_from, valid_to) with &&
  ) where (revoked_at is null);

create index access_grant_by_principal
  on org.access_grant (organization_id, principal_id, capability)
  where revoked_at is null;
create index access_grant_by_scope
  on org.access_grant (organization_id, scope_object_id)
  where revoked_at is null;

comment on table org.access_grant is
  'Positive, effective-dated, revocable need-to-know. Never a column on the object or the person.';

-- The principal must belong to the organization the grant is made in, and must be of the kind
-- the row claims. A grant naming a person from another organization would be authority leaking
-- across the product-instance boundary (ADR 0006).
create or replace function org.access_grant_guard() returns trigger
language plpgsql
set search_path = pg_catalog, org, core
as $$
declare
  v_kind text;
  v_org uuid;
  v_scope_org uuid;
begin
  select o.object_type, o.organization_id into v_kind, v_org
    from core.object o where o.id = new.principal_id;
  if v_kind is null then
    raise exception 'access grant principal % does not exist', new.principal_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_kind <> new.principal_kind then
    raise exception 'access grant principal % is a %, not a %',
      new.principal_id, v_kind, new.principal_kind
      using errcode = 'check_violation';
  end if;
  if v_org <> new.organization_id then
    raise exception 'access grant principal % belongs to another organization', new.principal_id
      using errcode = 'check_violation';
  end if;
  select o.organization_id into v_scope_org from core.object o where o.id = new.scope_object_id;
  if v_scope_org is null or v_scope_org <> new.organization_id then
    raise exception 'access grant scope % is not an object of organization %',
      new.scope_object_id, new.organization_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger access_grant_guard
  before insert or update on org.access_grant
  for each row execute function org.access_grant_guard();

-- Secure-object capabilities are grants on EXTERNAL opaque objects; the ledger is not
-- readable by the application role and must stay that way. This definer function exposes
-- only the grant-shaped facts, for one organization, with a fixed search path.
create or replace function org.secure_object_capability_grants(p_organization uuid)
returns table (
  source_id           uuid,
  organization_id     uuid,
  principal_id        uuid,
  scope_external_ref  text,
  classification      text,
  valid_from          timestamptz,
  valid_to            timestamptz,
  granted_by_action   uuid
)
language sql
stable
security definer
set search_path = pg_catalog, secure_object, org
as $$
  select issue.id,
         request.organization_id,
         issue.actor_id,
         request.external_authority_ref || '@' || request.external_revision_ref,
         request.classification_id,
         issue.issued_at,
         revocation.revoked_at,
         issue.action_id
    from secure_object.capability_issue issue
    join secure_object.capability_request request on request.id = issue.request_id
    left join secure_object.capability_revocation revocation
      on revocation.capability_id = issue.id
   where request.organization_id = p_organization
$$;

revoke all on function org.secure_object_capability_grants(uuid) from public;
grant execute on function org.secure_object_capability_grants(uuid) to kf_app, kf_worker, kf_readonly, kf_auditor;

-- One shape for every source of access. `security_invoker` so the caller's row-level security
-- applies to the underlying tables: a view that ran as its owner would read across
-- organizations.
create view org.effective_access_grant with (security_invoker = true) as
  select 'access_grant'::text        as source,
         g.id                        as source_id,
         g.organization_id,
         g.principal_kind,
         g.principal_id,
         g.capability,
         g.scope_object_id,
         null::text                  as scope_external_ref,
         g.classification_ceiling,
         g.valid_from,
         g.valid_to,
         g.granted_by,
         g.granted_by_action,
         g.reason
    from org.access_grant g
   where g.revoked_at is null
  union all
  -- A role assignment is read AND act authority at its scope. The assignment's own
  -- `classification_ceiling` is the cap the resolver already applies.
  select 'role_assignment', ra.id, envelope.organization_id, 'person', ra.subject_id,
         capability.name, ra.scope_id, null, ra.classification_ceiling, ra.valid_from,
         ra.valid_to, ra.delegated_by, null, 'role ' || ra.role_id
    from org.role_assignment ra
    join core.object envelope on envelope.id = ra.id
    cross join (values ('read'), ('act')) as capability (name)
   where envelope.lifecycle_state = 'active'
  union all
  select 'project_membership', pm.id, project.organization_id, 'person', pm.person_id, 'read',
         pm.project_id, null, null, pm.valid_from, pm.valid_to, null, null, 'project membership'
    from org.project_membership pm
    join core.object project on project.id = pm.project_id
  union all
  select 'capability_issue', c.source_id, c.organization_id, 'person', c.principal_id, 'read',
         null, c.scope_external_ref, c.classification, c.valid_from, c.valid_to, null,
         c.granted_by_action, 'secure object capability'
    from org.organization o
    cross join lateral org.secure_object_capability_grants(o.id) c;

comment on view org.effective_access_grant is
  'Every live source of access in one shape: direct grants, role assignments, project memberships, secure-object capabilities.';

alter table org.access_grant enable row level security;
alter table org.access_grant force row level security;
create policy access_grant_scope on org.access_grant
  for select using (
    organization_id = core.current_organization()
    and exists (select 1 from core.object envelope where envelope.id = access_grant.scope_object_id)
  );
create policy access_grant_write on org.access_grant
  for insert with check (
    organization_id = core.current_organization()
    and granted_by = core.current_actor()
    and granted_by_action = core.current_action_id()
    and exists (select 1 from core.object envelope where envelope.id = access_grant.scope_object_id)
  );
-- Revocation is the only update, and it must name the revoking actor and act.
create policy access_grant_revoke on org.access_grant
  for update using (
    organization_id = core.current_organization()
    and revoked_at is null
  ) with check (
    organization_id = core.current_organization()
    and revoked_by = core.current_actor()
    and revoked_by_action = core.current_action_id()
  );
create policy access_grant_backup_read on org.access_grant for select to kf_backup using (true);

grant select on org.access_grant, org.effective_access_grant
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert, update on org.access_grant to kf_app;

-- migrate:down

drop policy access_grant_backup_read on org.access_grant;
drop policy access_grant_revoke on org.access_grant;
drop policy access_grant_write on org.access_grant;
drop policy access_grant_scope on org.access_grant;
drop view org.effective_access_grant;
drop function org.secure_object_capability_grants(uuid);
drop trigger access_grant_guard on org.access_grant;
drop function org.access_grant_guard();
drop table org.access_grant;
