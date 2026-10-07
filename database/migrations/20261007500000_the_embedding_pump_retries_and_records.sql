-- migrate:up

-- The embedding pump retries with backoff, records what it gave up on, and never lets two
-- embeddings of one record race (SAS §100.44, KF-SAS-RQ-201, RQ-225).
--
-- Three defects in the queue of 20260925071000, each fixed here:
--
--   1. A FAILURE WAS RETRIED FOREVER, AT THE LEASE'S PACE, AND RECORDED NOWHERE. A record the
--      engine refused stayed claimed until its lease lapsed and was claimed again, every lease, for
--      as long as the engine kept refusing it; the only trace was a worker log line. Now a failure
--      is counted: the record waits `base · 2^(attempts−1)` seconds (capped at an hour) before it
--      may be claimed again, and after `max_attempts` it is RECORDED as failed — `failed_at`, the
--      failure's class, the attempt count — and no longer claimed. Re-enqueueing it (an edit to
--      the record, or `stack.sh reindex`) clears all of that and tries again.
--
--   2. AN EDIT DURING AN EMBEDDING RACED IT. `enqueue_embedding` cleared a live claim, so a second
--      consumer could claim the record at once and embed the new text while the first was still
--      embedding the old. The engine stores whichever vector arrives LAST, and the first worker's
--      completion — refused, its claim gone — left nothing to notice when that was the old one: the
--      record kept a vector of text it no longer holds, and the queue row was deleted by the
--      second completion. Now an enqueue during a live claim only marks the row `requeued`; the
--      claim stays, so no second consumer can take it, and the claim's completion (or failure)
--      makes it claimable again, so the new text is embedded after the old, never beside it.
--
--   3. Nothing here bounded how long a claim's holder works — that is the worker's job, and it
--      now claims one record per consumer, so a lease covers one engine request rather than a
--      whole batch queued behind other consumers (apps/worker/src/embedding.ts). A lease that
--      lapses under a live worker is the one way left to embed a record twice; the worker
--      refuses a lease shorter than twice its engine timeout.
--
-- `claimed_until` keeps its name and gains a second use: after a failure it is the time before
-- which the record may not be claimed, with no claim holding it.
--
-- Still derived and still disposable (§64A): no application grant on the table, only the definer
-- seams below, executable by kf_worker. No table is added, so no new guard is owed; the columns
-- added are bookkeeping about the queue, not authorization inputs.

alter table retrieval.embed_pending
  add column attempts  integer not null default 0 check (attempts >= 0),
  add column requeued  boolean not null default false,
  add column failed_at timestamptz,
  add column failure   text check (failure in ('engine_refused', 'engine_unavailable', 'completion_failed')),
  add constraint embed_pending_failure_recorded check (failed_at is null or failure is not null);

comment on column retrieval.embed_pending.claimed_until is
  'While a claim is held, when its lease lapses. With no claim after a failure, the time before '
  'which the record may not be claimed again (its backoff).';
comment on column retrieval.embed_pending.attempts is
  'Failed attempts since the record was last enqueued.';
comment on column retrieval.embed_pending.requeued is
  'Enqueued again while a claim was live: the text sent is stale, so the claim''s end makes the '
  'record claimable again instead of removing it.';
comment on column retrieval.embed_pending.failed_at is
  'When the pump gave up: after this the record is not claimed until it is enqueued again.';
comment on column retrieval.embed_pending.failure is
  'The class of the last failure. A class, never the engine''s words, which could quote text.';

-- Claims skip what has been given up on, so the order index skips it too.
drop index retrieval.embed_pending_order;
create index embed_pending_order on retrieval.embed_pending (enqueued_at) where failed_at is null;

create or replace function retrieval.enqueue_embedding(p_object_ids uuid[]) returns integer
language plpgsql
security definer
set search_path = pg_catalog, core, retrieval
as $$
declare
  v_count integer;
begin
  insert into retrieval.embed_pending as p (object_id, organization_id)
  select o.id, o.organization_id
    from core.object o
   where o.id = any(coalesce(p_object_ids, '{}'::uuid[]))
  on conflict (object_id) do update
    set enqueued_at = now(),
        attempts = 0,
        failed_at = null,
        failure = null,
        -- A live claim is kept and marked: its holder is embedding the old text, and the new text
        -- is embedded after it, never beside it. Anything else (no claim, a lapsed lease, a
        -- backoff) is cleared, so the new text is claimable at once.
        requeued = (p.claim is not null and p.claimed_until >= now()),
        claim = case when p.claim is not null and p.claimed_until >= now() then p.claim end,
        claimed_until = case when p.claim is not null and p.claimed_until >= now()
                             then p.claimed_until end;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

create or replace function retrieval.claim_embeddings(p_limit integer, p_lease_seconds integer)
returns table (object_id uuid, organization_id uuid, text text, claim uuid)
language plpgsql
security definer
set search_path = pg_catalog, core, retrieval, search
as $$
#variable_conflict use_column
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'claim between 1 and 1000 records' using errcode = 'invalid_parameter_value';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'lease between 1 and 3600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  return query
    with claimable as (
      select p.object_id
        from retrieval.embed_pending p
       where p.failed_at is null
         and (p.claimed_until is null or p.claimed_until < now())
       order by p.enqueued_at
       limit p_limit
         for update skip locked
    ),
    claimed as (
      update retrieval.embed_pending p
         set claimed_until = now() + make_interval(secs => p_lease_seconds),
             claim = uuidv7(),
             -- This claim reads the text as it is now, so nothing it holds is stale.
             requeued = false
        from claimable c
       where p.object_id = c.object_id
      returning p.object_id, p.organization_id, p.claim
    )
    select c.object_id, c.organization_id,
           coalesce(d.title || E'\n\n' || d.body, o.title) as text,
           c.claim
      from claimed c
      join core.object o on o.id = c.object_id
      left join search.document d on d.object_id = c.object_id
     order by c.object_id;
end
$$;

/**
 * Finish one claimed record. Removes it only if the claim is still the one the worker holds; a
 * record enqueued again while it was being embedded is released for the new text instead. Answers
 * whether the claim was still held.
 */
create or replace function retrieval.complete_embedding(p_object_id uuid, p_claim uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, retrieval
as $$
declare
  v_requeued boolean;
begin
  select p.requeued into v_requeued
    from retrieval.embed_pending p
   where p.object_id = p_object_id and p.claim = p_claim
     for update;
  if not found then
    return false;
  end if;
  if v_requeued then
    update retrieval.embed_pending
       set claim = null, claimed_until = null, requeued = false
     where object_id = p_object_id;
  else
    delete from retrieval.embed_pending where object_id = p_object_id;
  end if;
  return true;
end
$$;

/**
 * Count one failed attempt on a claimed record, and either schedule its retry or record that the
 * pump gave up. Answers `retry`, `recorded` (given up: failed_at set), `requeued` (the text moved
 * while it was being embedded, so the failure is not counted and the new text is claimable now),
 * or `superseded` (the claim is no longer held; nothing changed).
 *
 * The backoff is base · 2^(attempts−1) seconds, capped at an hour. The worker passes its policy;
 * the bounds here keep any caller's inside reason.
 */
create function retrieval.fail_embedding(
  p_object_id uuid,
  p_claim uuid,
  p_failure text,
  p_base_seconds integer,
  p_max_attempts integer
) returns text
language plpgsql
security definer
set search_path = pg_catalog, retrieval
as $$
declare
  v_row retrieval.embed_pending%rowtype;
  v_attempts integer;
begin
  if p_failure is null
     or p_failure not in ('engine_refused', 'engine_unavailable', 'completion_failed') then
    raise exception 'an embedding failure is engine_refused, engine_unavailable or completion_failed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_base_seconds is null or p_base_seconds < 1 or p_base_seconds > 3600 then
    raise exception 'backoff base between 1 and 3600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 100 then
    raise exception 'between 1 and 100 attempts' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_row
    from retrieval.embed_pending p
   where p.object_id = p_object_id and p.claim = p_claim
     for update;
  if not found then
    return 'superseded';
  end if;
  if v_row.requeued then
    update retrieval.embed_pending
       set claim = null, claimed_until = null, requeued = false
     where object_id = p_object_id;
    return 'requeued';
  end if;
  v_attempts := v_row.attempts + 1;
  if v_attempts >= p_max_attempts then
    update retrieval.embed_pending
       set attempts = v_attempts, failure = p_failure, failed_at = now(),
           claim = null, claimed_until = null
     where object_id = p_object_id;
    return 'recorded';
  end if;
  update retrieval.embed_pending
     set attempts = v_attempts, failure = p_failure, claim = null,
         claimed_until = now() + make_interval(
           secs => least(3600, p_base_seconds::double precision * power(2, v_attempts - 1)))
   where object_id = p_object_id;
  return 'retry';
end
$$;

/**
 * The queue's state, as counts: how many records wait, how many are held by a claim, how many
 * are backing off after a failure, and how many the pump gave up on, by failure class. For the
 * worker's log and an operator; carries no identifier.
 */
create function retrieval.embedding_backlog()
returns table (waiting bigint, claimed bigint, backing_off bigint, gave_up bigint,
               gave_up_refused bigint, gave_up_unavailable bigint, gave_up_completion bigint)
language sql
stable
security definer
set search_path = pg_catalog, retrieval
as $$
  select count(*) filter (where failed_at is null and claim is null
                            and (claimed_until is null or claimed_until < now())),
         count(*) filter (where failed_at is null and claim is not null),
         count(*) filter (where failed_at is null and claim is null and claimed_until >= now()),
         count(*) filter (where failed_at is not null),
         count(*) filter (where failed_at is not null and failure = 'engine_refused'),
         count(*) filter (where failed_at is not null and failure = 'engine_unavailable'),
         count(*) filter (where failed_at is not null and failure = 'completion_failed')
    from retrieval.embed_pending
$$;

revoke all on function retrieval.fail_embedding(uuid, uuid, text, integer, integer) from public;
revoke all on function retrieval.embedding_backlog() from public;
grant execute on function retrieval.fail_embedding(uuid, uuid, text, integer, integer) to kf_worker;
grant execute on function retrieval.embedding_backlog() to kf_worker;

-- migrate:down

drop function retrieval.embedding_backlog();
drop function retrieval.fail_embedding(uuid, uuid, text, integer, integer);

create or replace function retrieval.complete_embedding(p_object_id uuid, p_claim uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, retrieval
as $$
declare
  v_found boolean;
begin
  delete from retrieval.embed_pending where object_id = p_object_id and claim = p_claim;
  get diagnostics v_found = row_count;
  return v_found;
end
$$;

create or replace function retrieval.claim_embeddings(p_limit integer, p_lease_seconds integer)
returns table (object_id uuid, organization_id uuid, text text, claim uuid)
language plpgsql
security definer
set search_path = pg_catalog, core, retrieval, search
as $$
#variable_conflict use_column
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'claim between 1 and 1000 records' using errcode = 'invalid_parameter_value';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'lease between 1 and 3600 seconds' using errcode = 'invalid_parameter_value';
  end if;
  return query
    with claimable as (
      select p.object_id
        from retrieval.embed_pending p
       where p.claimed_until is null or p.claimed_until < now()
       order by p.enqueued_at
       limit p_limit
         for update skip locked
    ),
    claimed as (
      update retrieval.embed_pending p
         set claimed_until = now() + make_interval(secs => p_lease_seconds),
             claim = uuidv7()
        from claimable c
       where p.object_id = c.object_id
      returning p.object_id, p.organization_id, p.claim
    )
    select c.object_id, c.organization_id,
           coalesce(d.title || E'\n\n' || d.body, o.title) as text,
           c.claim
      from claimed c
      join core.object o on o.id = c.object_id
      left join search.document d on d.object_id = c.object_id
     order by c.object_id;
end
$$;

create or replace function retrieval.enqueue_embedding(p_object_ids uuid[]) returns integer
language plpgsql
security definer
set search_path = pg_catalog, core, retrieval
as $$
declare
  v_count integer;
begin
  insert into retrieval.embed_pending (object_id, organization_id)
  select o.id, o.organization_id
    from core.object o
   where o.id = any(coalesce(p_object_ids, '{}'::uuid[]))
  on conflict (object_id) do update
    set enqueued_at = now(), claimed_until = null, claim = null;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

drop index retrieval.embed_pending_order;
create index embed_pending_order on retrieval.embed_pending (enqueued_at);

alter table retrieval.embed_pending
  drop constraint embed_pending_failure_recorded,
  drop column failure,
  drop column failed_at,
  drop column requeued,
  drop column attempts;
