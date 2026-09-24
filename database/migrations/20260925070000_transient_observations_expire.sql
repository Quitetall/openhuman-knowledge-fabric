-- migrate:up

-- Transient observations, and the demand aggregate that is kept (§64B, ADR 0029,
-- KF-SAS-RQ-219 to RQ-222).
--
-- A recorded query observes something that happened once. It is not a record — Law 6 is not
-- touched, because a query never was one — and it cannot be rebuilt from anything, so it is not
-- a derived projection either. It is the third category ADR 0029 names: kept for a stated window,
-- then gone, and gone everywhere. The four exclusions that make "gone" true (the preservation
-- export, the master-record boundary, checkpoint coverage, backup data) are declared in
-- docs/architecture/master-record-boundary.json under `transientTables` and held by
-- tests/conformance/transient-observations.test.ts.
--
-- NO APPLICATION ROLE WRITES ANY TABLE HERE. Every row is written by a definer seam that takes
-- the organization, the ceiling and the person from the sealed context and never from an
-- argument. That is also why none of these tables carries the act write guard (20260925011000):
-- the guard is installed on tables kf_app or kf_worker may write, and these have no write grant.
-- A query is not an act, and recording one must not need one.
--
-- WHO ASKED, WITHOUT NAMING THEM. The aggregate has to tell fifty people wanting a record from one
-- person wanting it fifty times (ADR 0029), so the log has to distinguish askers. It does so with
-- `asker_key`: an HMAC of the person under a key in search.asker_key, which no application role
-- can read, and which is itself a transient observation with the same window. No column here
-- names a person or references org.person; turning a key back into a person needs the owner
-- credential and a list of candidates, which is a deliberate act rather than a column on a
-- dashboard. After the key is swept, not even that.

-- ── The pseudonym key ────────────────────────────────────────────────────────────────────────

create table search.asker_key (
  id         bigint generated always as identity primary key,
  key        bytea not null check (octet_length(key) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  check (expires_at > created_at)
);

comment on table search.asker_key is
  'Transient observation (§64B): the HMAC key that makes recorded queries distinguish askers '
  'without naming them. No application grant; rotates with the 90-day window and is swept.';

alter table search.asker_key enable row level security;
alter table search.asker_key force row level security;
revoke all on search.asker_key from public;

-- ── Recorded queries ─────────────────────────────────────────────────────────────────────────

create table search.recorded_query (
  id              uuid primary key default uuidv7(),
  organization_id uuid not null,
  query_text      text not null check (length(query_text) between 1 and 512),
  asker_ceiling   text not null references registry.classification (id),
  -- The ceiling's rank, written by the seam from the same registry row. Compared directly by the
  -- read policy, so the policy looks nothing up per row (20260817000300).
  asker_rank      integer not null,
  asker_key       bytea not null check (octet_length(asker_key) = 32),
  recorded_at     timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '90 days',
  check (expires_at > recorded_at)
);

create index recorded_query_expiry on search.recorded_query (expires_at);

comment on table search.recorded_query is
  'Transient observation (§64B, KF-SAS-RQ-221): a query somebody ran, with the ceiling they ran it '
  'at and a pseudonymous asker key. No person column. Expires after 90 days.';

alter table search.recorded_query enable row level security;
alter table search.recorded_query force row level security;

-- A recorded query is readable in its organization by somebody cleared at least as high as the
-- person who asked it: the text of a question can itself be as sensitive as what it looked for.
create policy recorded_query_read on search.recorded_query for select
  using (
    organization_id = (select core.current_organization())
    and asker_rank <= (select core.current_classification_rank())
  );

revoke all on search.recorded_query from public;
-- Column grants: the asker key is not among them. Reading the log WITH attribution is its own act
-- (ADR 0029), and no application login may perform it.
grant select (id, organization_id, query_text, asker_ceiling, asker_rank, recorded_at, expires_at)
  on search.recorded_query to kf_app;

-- ── Per-asker contributions to the aggregate ─────────────────────────────────────────────────

-- The memory that keeps the aggregate a count of DISTINCT persons: one row per (record, asker
-- key) already counted. Transient like the log it came from; a person whose key rotated between
-- two replays is counted again, which the aggregate's comment states.
create table search.demand_contribution (
  organization_id uuid not null,
  object_id       uuid not null,
  asker_key       bytea not null check (octet_length(asker_key) = 32),
  contributed_at  timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '90 days',
  primary key (object_id, asker_key),
  check (expires_at > contributed_at)
);

comment on table search.demand_contribution is
  'Transient observation (§64B): which pseudonymous askers have already been counted toward a '
  'record''s demand. No application grant. Expires after 90 days.';

alter table search.demand_contribution enable row level security;
alter table search.demand_contribution force row level security;
revoke all on search.demand_contribution from public;

-- ── The durable aggregate ────────────────────────────────────────────────────────────────────

create table org.access_demand (
  object_id             uuid primary key references core.object (id),
  organization_id       uuid not null,
  distinct_person_count integer not null check (distinct_person_count > 0),
  first_counted_at      timestamptz not null default now(),
  last_counted_at       timestamptz not null default now()
);

comment on table org.access_demand is
  'Demand for access (§64B, KF-SAS-RQ-221): a record that recurred in higher-clearance replays of '
  'lower-clearance queries, and how many distinct persons asked. Never which persons. Biased toward '
  'people still searching, so a quiet report is not evidence of no unmet demand (§100.23).';

alter table org.access_demand enable row level security;
alter table org.access_demand force row level security;

-- Visibility defers to the record (KF-SAS-RQ-226): a demand count about a record the caller
-- cannot see would say that the record exists.
create policy access_demand_read on org.access_demand for select
  using (
    organization_id = (select core.current_organization())
    and exists (select 1 from core.object o where o.id = object_id)
  );
-- Preservation is deliberately cross-organization, as for every other record.
create policy access_demand_backup on org.access_demand for select to kf_backup using (true);

revoke all on org.access_demand from public;
grant select on org.access_demand to kf_app, kf_backup;

-- ── What a semantic answer disclosed ─────────────────────────────────────────────────────────

create table retrieval.disclosure (
  id              uuid primary key default uuidv7(),
  organization_id uuid not null,
  trace_digest    text not null check (trace_digest ~ '^[A-Za-z0-9:+/=_.-]{8,255}$'),
  semantic_hits   integer not null check (semantic_hits >= 0),
  near_misses     integer not null check (near_misses >= 0),
  recorded_at     timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '90 days',
  check (expires_at > recorded_at)
);

create index disclosure_expiry on retrieval.disclosure (expires_at);

comment on table retrieval.disclosure is
  'Transient observation (§64B, KF-SAS-RQ-219): the digest of the retrieval engine''s trace for '
  'one served semantic answer. The trace stays disposable in the engine; this row names no person. '
  'Expires after 90 days.';

alter table retrieval.disclosure enable row level security;
alter table retrieval.disclosure force row level security;

create policy disclosure_read on retrieval.disclosure for select
  using (organization_id = (select core.current_organization()));

revoke all on retrieval.disclosure from public;
grant select on retrieval.disclosure to kf_app;

-- ── Seams ────────────────────────────────────────────────────────────────────────────────────

/** The current pseudonym key, made when there is none. Serialized so two askers make one. */
create function search.current_asker_key() returns bytea
language plpgsql
security definer
set search_path = pg_catalog, search
as $$
declare
  v_key bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('kf:search:asker-key', 0));
  select k.key into v_key
    from search.asker_key k
   where k.expires_at > now()
   order by k.created_at desc
   limit 1;
  if v_key is null then
    insert into search.asker_key (key) values (public.gen_random_bytes(32))
    returning key into v_key;
  end if;
  return v_key;
end
$$;

/**
 * Record one query as a transient observation. Everything but the text comes from the sealed
 * context: the organization, the ceiling the query ran at, and the person — the bound principal,
 * or for a service the acting identity — who is recorded only as an HMAC under the current key.
 */
create function search.record_query(p_text text) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, search
as $$
declare
  v_ceiling text;
  v_rank    integer := core.current_classification_rank();
  v_asker   text := coalesce(core.sealed_setting('kf.principal', true),
                             core.sealed_setting('kf.actor', true));
  v_id      uuid;
begin
  if v_asker is null then
    raise exception 'a query is recorded only for a bound principal'
      using errcode = 'insufficient_privilege';
  end if;
  select c.id into v_ceiling
    from registry.classification c
   where c.rank = v_rank;
  if v_ceiling is null then
    raise exception 'a query is recorded only under a bound ceiling'
      using errcode = 'insufficient_privilege';
  end if;
  insert into search.recorded_query
    (organization_id, query_text, asker_ceiling, asker_rank, asker_key)
  values (
    core.current_organization(),
    btrim(p_text),
    v_ceiling,
    v_rank,
    public.hmac(convert_to(v_asker, 'UTF8'), search.current_asker_key(), 'sha256')
  )
  returning id into v_id;
  return v_id;
end
$$;

/**
 * Count a replay's findings toward the demand aggregate.
 *
 * The replayer supplies record ids; this function believes none of them. A record counts only if
 * it is in the replayer's organization, at or below the replayer's ceiling, ABOVE the original
 * asker's ceiling (so the asker's ceiling withheld it), and actually matches the recorded query.
 * Each counts once per distinct asker key. Returns how many new contributions were counted. What
 * was withheld is not stored — only that one more distinct person wanted this record.
 */
create function search.record_demand(p_recorded_query uuid, p_object_ids uuid[]) returns integer
language plpgsql
security definer
set search_path = pg_catalog, core, search, org
as $$
declare
  v_query   search.recorded_query%rowtype;
  v_rank    integer := core.current_classification_rank();
  v_org     uuid := core.current_organization();
  v_counted integer := 0;
  v_object  uuid;
  v_pattern text;
begin
  select q.* into v_query
    from search.recorded_query q
   where q.id = p_recorded_query
     and q.organization_id = v_org
     and q.expires_at > now()
     and q.asker_rank <= v_rank;
  if not found then
    raise exception 'no recorded query % is visible to this replayer', p_recorded_query
      using errcode = 'no_data_found';
  end if;

  v_pattern := replace(replace(replace(v_query.query_text, '!', '!!'), '%', '!%'), '_', '!_');

  for v_object in
    select d.object_id
      from search.document d
      join core.object o on o.id = d.object_id
      join registry.classification oc on oc.id = o.classification
     where d.object_id = any(coalesce(p_object_ids, '{}'::uuid[]))
       and o.organization_id = v_org
       and oc.rank <= v_rank
       and oc.rank > v_query.asker_rank
       and (d.document @@ websearch_to_tsquery('english', v_query.query_text)
            or d.title ilike '%' || v_pattern || '%' escape '!'
            or d.body ilike '%' || v_pattern || '%' escape '!')
  loop
    insert into search.demand_contribution (organization_id, object_id, asker_key)
    values (v_org, v_object, v_query.asker_key)
    on conflict do nothing;
    if found then
      insert into org.access_demand (object_id, organization_id, distinct_person_count)
      values (v_object, v_org, 1)
      on conflict (object_id) do update
        set distinct_person_count = org.access_demand.distinct_person_count + 1,
            last_counted_at = now();
      v_counted := v_counted + 1;
    end if;
  end loop;
  return v_counted;
end
$$;

/** Record the digest of one served semantic answer (KF-SAS-RQ-219). No person is named. */
create function retrieval.record_disclosure(
  p_trace_digest text,
  p_semantic_hits integer,
  p_near_misses integer
) returns uuid
language sql
security definer
set search_path = pg_catalog, core, retrieval
as $$
  insert into retrieval.disclosure (organization_id, trace_digest, semantic_hits, near_misses)
  values (core.current_organization(), p_trace_digest, p_semantic_hits, p_near_misses)
  returning id
$$;

/**
 * Delete every expired transient observation, and say how many from each table.
 *
 * The list is the declared transient class, and tests/database/transient-observations.test.ts
 * holds it equal to docs/architecture/master-record-boundary.json: a transient table this sweep
 * does not name is one whose expiry is a comment.
 */
create function core.sweep_transient_observations()
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

revoke all on function search.current_asker_key() from public;
revoke all on function search.record_query(text) from public;
revoke all on function search.record_demand(uuid, uuid[]) from public;
revoke all on function retrieval.record_disclosure(text, integer, integer) from public;
revoke all on function core.sweep_transient_observations() from public;
grant execute on function search.record_query(text) to kf_app;
grant execute on function search.record_demand(uuid, uuid[]) to kf_app;
grant execute on function retrieval.record_disclosure(text, integer, integer) to kf_app;
grant execute on function core.sweep_transient_observations() to kf_worker;

comment on schema search is
  'Derived, not an authority: a disposable index, rebuilt by search.rebuild() from core.object and '
  'the typed tables, and transient observations of the queries run against it (§64B), which '
  'expire and are never restored.';
comment on schema retrieval is
  'Derived, not an authority: the retrieval index''s band version and embedding queue (§64A), and '
  'the transient digests of what it disclosed (§64B). Band membership is re-derived from '
  'core.object on every mask build.';

-- migrate:down

comment on schema retrieval is
  'Derived, not an authority: the retrieval index''s band version (§64A). Band membership is '
  're-derived from core.object on every mask build; the version only says when to re-derive.';
comment on schema search is
  'Derived, not an authority: a disposable index. Nothing here is a source of truth; '
  'search.rebuild() reconstructs every row from core.object and the typed tables.';

drop function core.sweep_transient_observations();
drop function retrieval.record_disclosure(text, integer, integer);
drop function search.record_demand(uuid, uuid[]);
drop function search.record_query(text);
drop function search.current_asker_key();
drop table retrieval.disclosure;
drop table org.access_demand;
drop table search.demand_contribution;
drop table search.recorded_query;
drop table search.asker_key;
