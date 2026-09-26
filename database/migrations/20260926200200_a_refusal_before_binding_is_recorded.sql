-- migrate:up

-- A context-source or search request refused before anybody is bound is recorded (§64B,
-- KF-SAS-RQ-219).
--
-- THE GAP. `search.context_disclosure` and `search.recorded_query` take who and where from the
-- sealed context, so they record only what happens after a principal is bound. A request that
-- kf-attestor refuses — a ceiling above the person's clearance (`classification_not_granted`), a
-- delegated token naming an agent nobody declared (`undeclared_agent`), a role not held — never
-- binds anybody, and left one attestor.log line naming the organization and the failure: not
-- attributable to anyone, and in a log the transient-observation rules do not govern (INT-07 S2
-- and S8a).
--
-- WHO WRITES IT. kf-attestor, and only it (`kf_attestor`). It is the one process that has verified
-- the token, so the issuer and subject it hands over are the token's, not a claim; the API, which
-- would otherwise write this, has bound nobody and can be believed about nothing. A login that may
-- vouch that a person is present may say that it refused to. The API adds only which surface was
-- asked (a closed vocabulary): the attestor records a refusal only when the API names one, so a
-- refusal on any other route stays a log line, as before.
--
-- WHAT A ROW HOLDS. The organization asked for — recorded only if such an organization exists, so
-- a caller cannot plant rows under an arbitrary id; the surface; the identity failure; the agent
-- client the token named, if any (a client id, as `agent_participation` holds it elsewhere); the
-- rank of the classification that was ASKED for, which is the read policy's bar; and the asker as
-- a keyed pseudonym under the same key `search.recorded_query` and `search.context_disclosure`
-- use. When the token's subject is linked to a person, the pseudonym is that person's — the same
-- value their recorded queries and disclosures carry, so one owner-credential attribution (a list
-- of candidate persons) covers all three. When it is linked to nobody (`unknown_subject`), it is
-- an HMAC of the issuer and subject, attributable only against the identity provider's own list;
-- `asker_kind` says which. No token, no claim, no name, no person column.
--
-- WHAT IT OMITS. Token defects (`no_token`, `invalid_token`) and `no_role_requested` are refused
-- before a subject is verified, so there is nobody to attribute them to and they are not recorded.
--
-- A TRANSIENT OBSERVATION, like its siblings: 90 days, swept by
-- core.sweep_transient_observations(), excluded from the preservation export, the master-record
-- boundary, checkpoint coverage and backup data. Readable in its organization by somebody cleared
-- at least as high as what was asked for, never the pseudonym itself.

create table search.identification_refusal (
  id              uuid primary key default uuidv7(),
  organization_id uuid not null,
  surface         text not null check (surface in (
                    'context-source/retrieve', 'context-source/read', 'context-source/revision',
                    'search')),
  failure         text not null check (failure in (
                    'unknown_subject', 'revoked_identity', 'role_not_held',
                    'classification_not_granted', 'assignment_ambiguous', 'no_live_assignment',
                    'undeclared_agent')),
  agent_client_id text check (agent_client_id is null
                              or agent_client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'),
  asker_kind      text not null check (asker_kind in ('person', 'subject')),
  asker_rank      integer not null,
  asker_key       bytea not null check (octet_length(asker_key) = 32),
  recorded_at     timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '90 days',
  check (expires_at > recorded_at)
);

create index identification_refusal_expiry on search.identification_refusal (expires_at);

comment on table search.identification_refusal is
  'Transient observation (§64B): a context-source or search request kf-attestor refused before a '
  'principal was bound — organization, surface, identity failure, agent client, the rank asked '
  'for, and the asker as the recorded-query pseudonym (of the person, or of the token subject when '
  'it names nobody). Written only by kf_attestor. Expires after 90 days.';

alter table search.identification_refusal enable row level security;
alter table search.identification_refusal force row level security;

create policy identification_refusal_read on search.identification_refusal for select
  using (
    organization_id = (select core.current_organization())
    and asker_rank <= (select core.current_classification_rank())
  );

revoke all on search.identification_refusal from public;
grant select (id, organization_id, surface, failure, agent_client_id, asker_kind, asker_rank,
              recorded_at, expires_at)
  on search.identification_refusal to kf_app;
-- The backup login takes the lock pg_dump needs and reads nothing; backup.sh excludes the rows.
grant maintain on search.identification_refusal to kf_backup;

/**
 * Record one refusal kf-attestor made after verifying a token. The organization must exist; the
 * person, when there is one, is found from the identity link, not taken from the caller; the rank
 * is that of the classification asked for (the highest there is for one this database does not
 * know). Returns the row's id, or null when the organization named does not exist.
 */
create function search.record_identification_refusal(
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
    -- Not a uuid, so never equal to a person's pseudonym input.
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

revoke all on function search.record_identification_refusal(text, text, uuid, text, text, text, text)
  from public;
grant usage on schema search to kf_attestor;
grant execute on function search.record_identification_refusal(text, text, uuid, text, text, text, text)
  to kf_attestor;

-- The sweep names every declared transient table (tests/database/transient-observations.test.ts).
create or replace function core.sweep_transient_observations()
returns table (table_name text, removed bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count bigint;
begin
  delete from search.recorded_query where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.recorded_query'; removed := v_count; return next;

  delete from search.demand_contribution where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.demand_contribution'; removed := v_count; return next;

  delete from retrieval.disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'retrieval.disclosure'; removed := v_count; return next;

  delete from search.context_disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.context_disclosure'; removed := v_count; return next;

  delete from search.identification_refusal where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.identification_refusal'; removed := v_count; return next;

  -- The key last: a row swept above may still have been keyed by it.
  delete from search.asker_key where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.asker_key'; removed := v_count; return next;
end
$$;

-- migrate:down

create or replace function core.sweep_transient_observations()
returns table (table_name text, removed bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count bigint;
begin
  delete from search.recorded_query where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.recorded_query'; removed := v_count; return next;

  delete from search.demand_contribution where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.demand_contribution'; removed := v_count; return next;

  delete from retrieval.disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'retrieval.disclosure'; removed := v_count; return next;

  delete from search.context_disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.context_disclosure'; removed := v_count; return next;

  -- The key last: a row swept above may still have been keyed by it.
  delete from search.asker_key where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.asker_key'; removed := v_count; return next;
end
$$;

drop function search.record_identification_refusal(text, text, uuid, text, text, text, text);
revoke usage on schema search from kf_attestor;
revoke maintain on search.identification_refusal from kf_backup;
drop table search.identification_refusal;
