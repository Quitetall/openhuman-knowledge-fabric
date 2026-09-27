-- migrate:up

-- Every live assignment a signed-in person holds, in every organization they hold one in, before
-- anybody is bound (ADR 0034 §2, ADR 0033).
--
-- The web application's context picker asked `org.resolve_identity_assignments` about ONE
-- organization: the context already in use, else the deployment's configured one. A person of any
-- other organization in the same database (the multi fixture holds six) was shown nothing and had
-- to type an organization id, an assignment id and a ceiling. What is true is simpler: the person
-- holds these assignments, in these organizations, and chooses one.
--
--   org.live_assignments_everywhere_of(person)
--   org.resolve_identity_assignments_everywhere(issuer, subject)
--                                       the same lists as 20260925090000's, across organizations,
--                                       each row naming its organization and that organization's
--                                       legal name. Executable by kf_attestor only, for the same
--                                       reason: the attestor has just verified the token whose
--                                       issuer and subject it passes, and there is no argument
--                                       that names anybody else. The API's login may not call
--                                       them.
--
-- An organization appears only through a live assignment the person holds in it: the rows come
-- from `org.live_assignments_of`, per organization, so an organization where they hold nothing —
-- every other tenant — is never named, not by id and not by name.
--
-- Finding which organizations to ask about reads the person's assignment envelopes across
-- organizations. That read is past forced row security, as every definer seam's is, on the owner's
-- BYPASSRLS (ADR 0026), which readiness requires of a host. On an owner without it the read sees
-- nothing and the lists are empty: the person is told they hold nothing, never shown more.

create function org.live_assignments_everywhere_of(p_person uuid)
returns table (
  organization_id uuid,
  legal_name      text,
  assignment_id   uuid,
  role_id         text,
  scope_id        uuid
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_held record;
begin
  for v_held in
    select held.organization_id, g.legal_name
      from (select distinct o.organization_id
              from org.role_assignment ra
              join core.object o on o.id = ra.id
             where ra.subject_id = p_person
               and o.lifecycle_state = 'active'
               and ra.valid_from <= now()
               and (ra.valid_to is null or ra.valid_to > now())) held
      join org.organization g on g.id = held.organization_id
     order by lower(g.legal_name), held.organization_id
  loop
    -- The assignments themselves through the one-organization lookup, which binds and restores
    -- its own provisional context: exactly what a picker asking about that organization lists.
    return query
      select v_held.organization_id, v_held.legal_name, a.assignment_id, a.role_id, a.scope_id
        from org.live_assignments_of(p_person, v_held.organization_id) a;
  end loop;
end
$$;

revoke all on function org.live_assignments_everywhere_of(uuid) from public;
grant execute on function org.live_assignments_everywhere_of(uuid) to kf_attestor;

comment on function org.live_assignments_everywhere_of(uuid) is
  'A person''s live role assignments in every organization they hold one in, with its legal name, '
  'before any binding. kf_attestor only (ADR 0034 §2); an organization they hold nothing in is '
  'never named.';

-- The attestor's form: the person is whoever the verified token's subject is linked to. The
-- refusals are 20260925090000's: no row for an unknown identity, one row saying so for a revoked
-- link, one row with no assignment for a person holding nothing live anywhere.
create function org.resolve_identity_assignments_everywhere(
  p_issuer  text,
  p_subject text
) returns table (
  person_id        uuid,
  identity_revoked boolean,
  organization_id  uuid,
  legal_name       text,
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
    return query
      select v_person, true, null::uuid, null::text, null::uuid, null::text, null::uuid;
    return;
  end if;
  return query
    select v_person, false, a.organization_id, a.legal_name, a.assignment_id, a.role_id,
           a.scope_id
      from org.live_assignments_everywhere_of(v_person) a;
  if not found then
    return query
      select v_person, false, null::uuid, null::text, null::uuid, null::text, null::uuid;
  end if;
end
$$;

revoke all on function org.resolve_identity_assignments_everywhere(text, text) from public;
grant execute on function org.resolve_identity_assignments_everywhere(text, text) to kf_attestor;

comment on function org.resolve_identity_assignments_everywhere(text, text) is
  'The live role assignments, in every organization, of the person a verified token''s issuer '
  'and subject are linked to. kf_attestor only (ADR 0034 §2).';

-- migrate:down

drop function org.resolve_identity_assignments_everywhere(text, text);
drop function org.live_assignments_everywhere_of(uuid);
