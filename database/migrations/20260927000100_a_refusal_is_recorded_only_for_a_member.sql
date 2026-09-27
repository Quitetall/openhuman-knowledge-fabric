-- migrate:up

-- A refusal before binding is recorded only for a person who belongs to the organization named.
--
-- THE HOLE (reported with 20260926200200, closed here on the owner's decision). The seam recorded
-- a refusal under any organization that exists. A subject linked to no person was recorded under
-- an HMAC of issuer and subject (`asker_kind = 'subject'`), and a linked person naming another
-- organization was recorded under that organization. So anybody holding a token the realm issued
-- — a person of no organization here, or of another one — could add rows to an organization's
-- log of refusals, as many as they liked, rows that organization's readers would see as its own.
--
-- THE RULE. A row is written only when the verified subject resolves, through
-- `org.external_identity`, to a person who belongs to the organization named: the person is that
-- organization's (`org.person.organization`), or holds or held a role assignment scoped to it or
-- to one of its records. Belonging is a fact the organization itself recorded, so a row can only
-- ever be about somebody the organization already knows, in its own log. Otherwise nothing is
-- written and the function returns null; the attestor's log line (`recorded: false`) is the only
-- trace, as it was for every refusal before 20260926200200. An unlinked subject is therefore never
-- recorded, and `asker_kind` is always `person`; the subject pseudonym is gone.
--
-- The rule is in THIS function, which is the only writer (no role may insert into the table): an
-- attestor that is bypassed, or a login that holds kf_attestor and calls the seam directly with a
-- forged subject, gets the same null. A forged issuer+subject that happens to name a real linked
-- person is still recorded only in that person's own organization, under that person's
-- pseudonym — and forging it needs the kf_attestor login, which can already attest for them.
--
-- A historical assignment counts, not only a live one: `no_live_assignment` and `role_not_held`
-- for somebody whose assignments have ended are exactly the refusals worth attributing, and the
-- assignment is the organization's own record of them.
--
-- Rows already written with `asker_kind = 'subject'` are left to expire with the 90-day sweep: they
-- are transient observations and deleting evidence is not this migration's call. The check is
-- added NOT VALID, so it binds every new row and says nothing about the old.

alter table search.identification_refusal
  add constraint identification_refusal_person_only check (asker_kind = 'person') not valid;

create or replace function search.record_identification_refusal(
  p_issuer       text,
  p_subject      text,
  p_organization uuid,
  p_requested    text,
  p_surface      text,
  p_failure      text,
  p_agent        text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, org, core, search, registry
as $$
declare
  v_person uuid;
  v_rank   integer;
  v_id     uuid;
begin
  if coalesce(btrim(p_issuer), '') = '' or coalesce(btrim(p_subject), '') = '' then
    raise exception 'an identification refusal is recorded only for a verified token subject'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_organization is null then
    return null;
  end if;

  select i.person_id into v_person
    from org.external_identity i
   where i.issuer = p_issuer and i.subject = p_subject
   order by i.revoked_at is not null, i.linked_at desc
   limit 1;
  -- Nobody this system knows: nothing to attribute, and no organization of theirs to record in.
  if v_person is null then
    return null;
  end if;
  -- Somebody, but not of the organization named: their refusal is not that organization's to see.
  if not exists (
       select 1 from org.person p
        where p.id = v_person and p.organization = p_organization)
     and not exists (
       select 1
         from org.role_assignment a
         join core.object scope on scope.id = a.scope_id
        where a.subject_id = v_person
          and (a.scope_id = p_organization or scope.organization_id = p_organization)) then
    return null;
  end if;

  select c.rank into v_rank from registry.classification c where c.id = p_requested;
  if v_rank is null then
    select max(c.rank) into v_rank from registry.classification c;
  end if;

  insert into search.identification_refusal
    (organization_id, surface, failure, agent_client_id, asker_kind, asker_rank, asker_key)
  values (
    p_organization, p_surface, p_failure, nullif(btrim(coalesce(p_agent, '')), ''), 'person',
    v_rank, public.hmac(convert_to(v_person::text, 'UTF8'), search.current_asker_key(), 'sha256')
  )
  returning id into v_id;
  return v_id;
end
$$;

comment on table search.identification_refusal is
  'Transient observation (§64B): a context-source or search request kf-attestor refused before a '
  'principal was bound — organization, surface, identity failure, agent client, the rank asked '
  'for, and the asker as the recorded-query pseudonym. Recorded only for a person who belongs to '
  'the organization named (20260927000100). Written only by kf_attestor. Expires after 90 days.';

-- migrate:down

comment on table search.identification_refusal is
  'Transient observation (§64B): a context-source or search request kf-attestor refused before a '
  'principal was bound — organization, surface, identity failure, agent client, the rank asked '
  'for, and the asker as the recorded-query pseudonym (of the person, or of the token subject when '
  'it names nobody). Written only by kf_attestor. Expires after 90 days.';

create or replace function search.record_identification_refusal(
  p_issuer       text,
  p_subject      text,
  p_organization uuid,
  p_requested    text,
  p_surface      text,
  p_failure      text,
  p_agent        text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, org, search, registry
as $$
declare
  v_person uuid;
  v_asker  text;
  v_kind   text;
  v_rank   integer;
  v_id     uuid;
begin
  if coalesce(btrim(p_issuer), '') = '' or coalesce(btrim(p_subject), '') = '' then
    raise exception 'an identification refusal is recorded only for a verified token subject'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_organization is null
     or not exists (select 1 from org.organization o where o.id = p_organization) then
    return null;
  end if;

  select i.person_id into v_person
    from org.external_identity i
   where i.issuer = p_issuer and i.subject = p_subject
   order by i.revoked_at is not null, i.linked_at desc
   limit 1;
  if v_person is null then
    v_kind := 'subject';
    v_asker := 'subject ' || p_issuer || ' ' || p_subject;
  else
    v_kind := 'person';
    v_asker := v_person::text;
  end if;

  select c.rank into v_rank from registry.classification c where c.id = p_requested;
  if v_rank is null then
    select max(c.rank) into v_rank from registry.classification c;
  end if;

  insert into search.identification_refusal
    (organization_id, surface, failure, agent_client_id, asker_kind, asker_rank, asker_key)
  values (
    p_organization, p_surface, p_failure, nullif(btrim(coalesce(p_agent, '')), ''), v_kind,
    v_rank, public.hmac(convert_to(v_asker, 'UTF8'), search.current_asker_key(), 'sha256')
  )
  returning id into v_id;
  return v_id;
end
$$;

alter table search.identification_refusal drop constraint identification_refusal_person_only;
