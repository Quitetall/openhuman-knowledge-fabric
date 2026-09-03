-- migrate:up

-- ADR 0016, second half. An `act` grant was recorded and explained but nothing consulted it:
-- the dispatcher proved only that the actor HOLDS the acting role assignment, never whether
-- that authority reaches the target. The ontology now says, per action type, whether the act
-- requires `act` authority at the target's scope (`requires: act`), and the dispatcher asks
-- the same view the read side uses (`org.effective_access_grant`): an organization-scoped
-- role assignment covers everything, an object-scoped grant covers that object. Actions
-- that do not declare it stay role-only.

alter table registry.action_type
  add column requires_capability text
    check (requires_capability is null or requires_capability = 'act');

comment on column registry.action_type.requires_capability is
  'ADR 0016: `act` means the actor needs a live act grant reaching the target scope or the organization.';

/*
 * Does a live `act` grant reach `p_subject` for every one of `p_targets`, in `p_organization`?
 *
 * Reached directly (principal is the person) or through a role assignment the person holds
 * right now. Organization-wide grants (scope = the organization) cover every target. Runs
 * as the caller so row-level security on every source applies; the dispatcher calls it after
 * the access context is bound.
 */
create or replace function org.act_grant_reaches(
  p_subject uuid,
  p_organization uuid,
  p_targets uuid[]
) returns boolean
language sql
stable
set search_path = pg_catalog, org
as $$
  with live as (
    select g.scope_object_id
      from org.effective_access_grant g
     where g.organization_id = p_organization
       and g.capability = 'act'
       and g.scope_object_id is not null
       and g.valid_from <= now()
       and (g.valid_to is null or g.valid_to > now())
       and (
         (g.principal_kind = 'person' and g.principal_id = p_subject)
         or (g.principal_kind = 'role_assignment' and exists (
               select 1 from org.role_assignment ra
                where ra.id = g.principal_id and ra.subject_id = p_subject
                  and ra.valid_from <= now()
                  and (ra.valid_to is null or ra.valid_to > now())))
       )
  )
  select exists (select 1 from live where scope_object_id = p_organization)
      or (cardinality(p_targets) > 0 and not exists (
            select 1 from unnest(p_targets) t(id)
             where not exists (select 1 from live where live.scope_object_id = t.id)))
$$;

revoke all on function org.act_grant_reaches(uuid, uuid, uuid[]) from public;
grant execute on function org.act_grant_reaches(uuid, uuid, uuid[]) to kf_app, kf_worker;

-- migrate:down

drop function org.act_grant_reaches(uuid, uuid, uuid[]);
alter table registry.action_type drop column requires_capability;
