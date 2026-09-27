-- migrate:up

-- Whose assignments the server may form an act under, when the person named none (ADR 0034 §2,
-- KF-SAS-RQ-200).
--
-- Recording an observation asks the person for no acting role: the server uses their only live
-- assignment in the organization, or refuses and lists them when there are several. Two lookups
-- make that possible, and neither lets the application read anybody's assignments but the
-- caller's own:
--
--   core.principal_live_assignments()   the BOUND principal's live assignments in the bound
--                                       organization. For kf_app: a transaction can only ever
--                                       ask about the person it is bound as, on their
--                                       attestation, so there is no argument to point it at
--                                       somebody else.
--
--   org.live_assignments_of(person, organization)
--   org.resolve_identity_assignments(issuer, subject, organization)
--                                       the same list BEFORE anybody is bound — a person who
--                                       named no assignment cannot be bound, because a binding
--                                       is to an assignment. Executable by kf_attestor only:
--                                       the attestor has just verified that person's bearer
--                                       token, and a login that may vouch any present person
--                                       into a binding learns nothing here it could not already
--                                       reach. The API's login may not call them (and refuses to
--                                       start holding kf_attestor outside development).
--
-- Each binds its own provisional context for the lookup, as core.assignment_is_live does —
-- core.object forces row security on its owner too — and restores the caller's before returning.

create function org.live_assignments_of(p_person uuid, p_organization uuid)
returns table (assignment_id uuid, role_id text, scope_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_org   text := core.sealed_setting('kf.organization', true);
  v_class text := core.sealed_setting('kf.max_classification', true);
begin
  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', 'restricted', true);
  return query
    select ra.id, ra.role_id, ra.scope_id
      from org.role_assignment ra
      join core.object o on o.id = ra.id
     where ra.subject_id = p_person
       and o.organization_id = p_organization
       and o.lifecycle_state = 'active'
       and ra.valid_from <= now()
       and (ra.valid_to is null or ra.valid_to > now())
     order by ra.valid_from, ra.id;
  perform core.seal_setting('kf.organization', v_org, true);
  perform core.seal_setting('kf.max_classification', v_class, true);
end
$$;

revoke all on function org.live_assignments_of(uuid, uuid) from public;
grant execute on function org.live_assignments_of(uuid, uuid) to kf_attestor;

comment on function org.live_assignments_of(uuid, uuid) is
  'A person''s live role assignments in an organization, before any binding. kf_attestor only '
  '(ADR 0034 §2): the application reads its own principal''s through '
  'core.principal_live_assignments().';

-- The attestor's form: the person is whoever the verified token's subject is linked to.
create function org.resolve_identity_assignments(
  p_issuer       text,
  p_subject      text,
  p_organization uuid
) returns table (
  person_id        uuid,
  identity_revoked boolean,
  assignment_id    uuid,
  role_id          text,
  scope_id         uuid
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, org, core
as $$
declare
  v_person  uuid;
  v_revoked boolean;
begin
  select identity.person_id, identity.revoked_at is not null
    into v_person, v_revoked
    from org.external_identity identity
   where identity.issuer = p_issuer
     and identity.subject = p_subject
   order by (identity.revoked_at is null) desc, identity.linked_at desc
   limit 1;
  if v_person is null then
    return;
  end if;
  if v_revoked then
    -- A revoked link lists nothing: one row saying so, and no assignments behind it.
    return query select v_person, true, null::uuid, null::text, null::uuid;
    return;
  end if;
  return query
    select v_person, false, a.assignment_id, a.role_id, a.scope_id
      from org.live_assignments_of(v_person, p_organization) a;
  if not found then
    -- Known and not revoked, but holding nothing live here: still one row, so the caller can
    -- tell "no assignment" from "no such person".
    return query select v_person, false, null::uuid, null::text, null::uuid;
  end if;
end
$$;

revoke all on function org.resolve_identity_assignments(text, text, uuid) from public;
grant execute on function org.resolve_identity_assignments(text, text, uuid) to kf_attestor;

-- The application's form: only ever the bound principal's own.
create function core.principal_live_assignments()
returns table (assignment_id uuid, role_id text, scope_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_principal    text := core.sealed_setting('kf.principal', true);
  v_organization text := core.sealed_setting('kf.principal_organization', true);
begin
  if v_principal is null or v_organization is null then
    raise exception 'no principal is bound in this transaction'
      using errcode = 'insufficient_privilege',
            hint = 'Bind the caller with core.bind_principal first; this lists only their own.';
  end if;
  return query
    select a.assignment_id, a.role_id, a.scope_id
      from org.live_assignments_of(v_principal::uuid, v_organization::uuid) a;
end
$$;

revoke all on function core.principal_live_assignments() from public;
grant execute on function core.principal_live_assignments() to kf_app;

comment on function core.principal_live_assignments() is
  'The bound principal''s own live role assignments in the bound organization (ADR 0034 §2). '
  'Refuses in a transaction with no principal bound.';

-- migrate:down

drop function core.principal_live_assignments();
drop function org.resolve_identity_assignments(text, text, uuid);
drop function org.live_assignments_of(uuid, uuid);
