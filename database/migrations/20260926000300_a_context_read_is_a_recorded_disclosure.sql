-- migrate:up

-- A context read is a disclosure, and so is a refusal to make one (KF-SAS-RQ-219, §59, §64B).
--
-- LAMU's context compiler reads KF through two routes (`POST /context-source/retrieve`,
-- `POST /context-source/read`, apps/api/src/routes/context-source.ts). Each answer puts record text,
-- or the identity of records, in front of an agent acting for a person. RQ-219 already holds the
-- kernel to recording what a semantic answer disclosed, as the digest of the engine's trace
-- (`retrieval.disclosure`); a context read is a second disclosure of the same kind, and a later
-- one: the text itself rather than a ranked list of ids. This table records both context
-- operations, the refusals as well as the answers, and binds every answer to the corpus the
-- person's `agent_context` projection is evaluated over — the `corpus_digest` of their current
-- master record (§59). An answer that could not be bound to one is not made.
--
-- WHAT A ROW HOLDS. The operation; the refusal code (KF-CTX-*) or null for an answer; the corpus
-- digest; for a read, the record, its revision (the master-record member digest) and the SHA-256
-- of the exact text served; for a retrieval, the tagged digest of the reference list and how many
-- references were served and how many semantic hits were left out because they were not members
-- of the person's agent_context. The declared agent the person acted through (ADR 0035), copied
-- from the sealed attestation exactly as `core.action.agent_participation` is; nothing the
-- application passes sets it.
--
-- WHAT A ROW DELIBERATELY OMITS. No text, no title, no query (the query is already a recorded
-- query under §64B when the retrieval ran it). No person: the asker is `asker_key`, the same keyed
-- pseudonym `search.recorded_query` carries, under the same key, which no application role can
-- read — attributable by the owner credential and a list of candidates, and by nobody else. A
-- refusal for a record that was not found (KF-CTX-001) names no record at all, so the log cannot
-- confirm that an identifier someone guessed exists, whatever organization it is in; the seam
-- refuses to write one that does.
--
-- A TRANSIENT OBSERVATION. Not a record (a read is not an act, ADR 0033) and not rebuildable, so
-- it is §64B's third category: 90 days, swept by core.sweep_transient_observations(), and excluded
-- from the preservation export, the master-record boundary, checkpoint coverage and backup data
-- (docs/architecture/master-record-boundary.json `transientTables`, held by
-- tests/conformance/transient-observations.test.ts). No application role writes it: the definer
-- seam takes the organization, ceiling, person and agent from the sealed context. In the `search`
-- schema beside the recorded queries whose pseudonym it shares, and not in `retrieval`, which holds
-- no bytea and no authorization input (tests/database/transient-observations.test.ts).

create table search.context_disclosure (
  id                  uuid primary key default uuidv7(),
  organization_id     uuid not null,
  operation           text not null check (operation in ('retrieve', 'read')),
  refusal             text check (refusal is null or refusal ~ '^KF-CTX-[0-9]{3}$'),
  corpus_digest       text check (corpus_digest is null or corpus_digest ~ '^[0-9a-f]{64}$'),
  object_id           uuid,
  revision            text check (revision is null or revision ~ '^[0-9a-f]{64}$'),
  text_digest         text check (text_digest is null or text_digest ~ '^[0-9a-f]{64}$'),
  references_digest   text check (references_digest is null or references_digest ~ '^[0-9a-f]{64}$'),
  reference_count     integer check (reference_count is null or reference_count >= 0),
  omitted_count       integer check (omitted_count is null or omitted_count >= 0),
  agent_participation text check (agent_participation is null
                                  or agent_participation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'),
  asker_rank          integer not null,
  asker_key           bytea not null check (octet_length(asker_key) = 32),
  recorded_at         timestamptz not null default now(),
  expires_at          timestamptz not null default now() + interval '90 days',
  check (expires_at > recorded_at),
  -- An answer is bound to a corpus and says exactly what it served; a not-found names nothing.
  constraint context_disclosure_shape check (
    (refusal is null and corpus_digest is not null and operation = 'read'
       and object_id is not null and revision is not null and text_digest is not null
       and references_digest is null)
    or (refusal is null and corpus_digest is not null and operation = 'retrieve'
       and object_id is null and revision is null and text_digest is null
       and references_digest is not null and reference_count is not null
       and omitted_count is not null)
    or (refusal = 'KF-CTX-001' and object_id is null and revision is null and text_digest is null)
    or (refusal is not null and refusal <> 'KF-CTX-001')
  )
);

create index context_disclosure_expiry on search.context_disclosure (expires_at);

comment on table search.context_disclosure is
  'Transient observation (§64B, KF-SAS-RQ-219): each context-source retrieval and read, answered or '
  'refused, bound to the asker''s agent_context corpus digest, with the declared agent from the '
  'attestation. No text, no query, no person column (a pseudonymous asker key). Expires after 90 days.';

alter table search.context_disclosure enable row level security;
alter table search.context_disclosure force row level security;

-- Readable in its organization by somebody cleared at least as high as the asker, and a row about a
-- record only by somebody who can see that record: that a record was disclosed is a fact about it.
create policy context_disclosure_read on search.context_disclosure for select
  using (
    organization_id = (select core.current_organization())
    and asker_rank <= (select core.current_classification_rank())
    and (object_id is null or exists (select 1 from core.object o where o.id = object_id))
  );

revoke all on search.context_disclosure from public;
-- Column grants: the asker key is not among them, as for search.recorded_query.
grant select (id, organization_id, operation, refusal, corpus_digest, object_id, revision,
              text_digest, references_digest, reference_count, omitted_count,
              agent_participation, asker_rank, recorded_at, expires_at)
  on search.context_disclosure to kf_app;

-- The backup login takes the lock pg_dump needs and reads nothing; backup.sh excludes the rows
-- (20260925130000).
grant maintain on search.context_disclosure to kf_backup;

/**
 * Record one context-source answer or refusal. Everything that says who and where comes from the
 * sealed context: the organization, the ceiling, the person (as the keyed pseudonym) and the agent.
 *
 * The seam believes none of its arguments about authority. The functions here run as the owner,
 * which row security may not bind, so every check filters explicitly on the bound organization and
 * ceiling. An answer's corpus digest must be that of the bound person's latest master record in the
 * organization at or below the bound ceiling — the claim `agent_context` is evaluated over — and a
 * read's record must be one that claim included at the revision served. A named
 * record must be one the bound ceiling reaches in the organization, except for KF-CTX-002 (a grant
 * that no longer reaches it), where it must instead be a record one of the person's own master
 * records included: the only record a refusal may name that the reader cannot see now is one KF
 * already told them about. KF-CTX-001 names no record.
 */
create function search.record_context_disclosure(
  p_operation         text,
  p_refusal           text,
  p_corpus_digest     text,
  p_object            uuid,
  p_revision          text,
  p_text_digest       text,
  p_references_digest text,
  p_reference_count   integer,
  p_omitted_count     integer
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, search, content, registry
as $$
declare
  v_principal text := core.sealed_setting('kf.principal', true);
  v_org       uuid := core.current_organization();
  v_rank      integer := core.current_classification_rank();
  v_latest    text;
  v_claim     uuid;
  v_id        uuid;
begin
  if v_principal is null or v_org is null then
    raise exception 'a context disclosure is recorded only for a bound person'
      using errcode = 'insufficient_privilege';
  end if;

  if p_corpus_digest is not null then
    select m.id, m.corpus_digest into v_claim, v_latest
      from content.master_record m
      join registry.classification c on c.id = m.effective_classification
     where m.person_id = v_principal::uuid
       and m.organization_id = v_org
       and c.rank <= v_rank
     order by m.compiled_at desc, m.recorded_at desc, m.id desc
     limit 1;
    if v_latest is distinct from p_corpus_digest then
      raise exception 'corpus digest % is not the bound person''s current master record', p_corpus_digest
        using errcode = 'insufficient_privilege';
    end if;
    -- A read is bound to the claim only if the claim included that record at that revision: the
    -- record is then a member of the person's agent_context, exactly as disclosed.
    if p_operation = 'read' and p_refusal is null and not exists (
      select 1 from content.master_record_item i
       where i.master_record_id = v_claim
         and i.object_id = p_object
         and i.item_state = 'included'
         and i.content_digest = p_revision) then
      raise exception 'record % at revision % is not in the master record it is bound to',
        p_object, p_revision
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if p_refusal = 'KF-CTX-001' and p_object is not null then
    raise exception 'a record that was not found is not named'
      using errcode = 'insufficient_privilege';
  end if;

  if p_object is not null then
    if p_refusal = 'KF-CTX-002' then
      if not exists (
        select 1
          from content.master_record m
          join registry.classification c on c.id = m.effective_classification
          join content.master_record_item i on i.master_record_id = m.id
         where m.person_id = v_principal::uuid
           and m.organization_id = v_org
           and c.rank <= v_rank
           and i.object_id = p_object
           and i.item_state = 'included') then
        raise exception 'record % was never in the bound person''s master record', p_object
          using errcode = 'insufficient_privilege';
      end if;
    elsif not exists (
      select 1
        from core.object o
        join registry.classification c on c.id = o.classification
       where o.id = p_object
         and o.organization_id = v_org
         and c.rank <= v_rank) then
      raise exception 'record % is not within the bound context', p_object
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  insert into search.context_disclosure
    (organization_id, operation, refusal, corpus_digest, object_id, revision, text_digest,
     references_digest, reference_count, omitted_count, agent_participation, asker_rank, asker_key)
  values (
    v_org, p_operation, p_refusal, p_corpus_digest, p_object, p_revision, p_text_digest,
    p_references_digest, p_reference_count, p_omitted_count,
    core.sealed_setting('kf.agent_participation', true),
    v_rank,
    public.hmac(convert_to(v_principal, 'UTF8'), search.current_asker_key(), 'sha256')
  )
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function search.record_context_disclosure(text, text, text, uuid, text, text, text, integer, integer)
  from public;
grant execute on function search.record_context_disclosure(text, text, text, uuid, text, text, text, integer, integer)
  to kf_app;

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

  delete from search.asker_key where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.asker_key'; removed := v_count; return next;
end
$$;

drop function search.record_context_disclosure(text, text, text, uuid, text, text, text, integer, integer);
revoke maintain on search.context_disclosure from kf_backup;
drop table search.context_disclosure;
