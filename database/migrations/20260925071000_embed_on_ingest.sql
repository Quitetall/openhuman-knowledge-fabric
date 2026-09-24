-- migrate:up

-- Embed on ingest (§64A, KF-SAS-RQ-225).
--
-- After an act commits, the outbox drain enqueues every object it touched here, in the same
-- transaction that marks the outbox row delivered. A separate worker pump then claims a batch in
-- one short transaction and commits, hands each record's text to the retrieval engine's
-- vectors-only write OUTSIDE any transaction, and completes each in another short transaction.
-- The engine can be slow or down without a database transaction staying open across it —
-- ADR 0028 rejected running retrieval inside the database for exactly that reason.
--
-- Derived, not authoritative: enqueueing every object again rebuilds the queue, and a lost row
-- costs one record a delayed embedding, never a disclosure (the mask pads an unembedded record
-- closed). No application role holds a grant on the table; the three definer seams below are the
-- only way in, so the act write guard (20260925011000) has nothing to guard.

create table retrieval.embed_pending (
  object_id       uuid primary key,
  organization_id uuid not null,
  enqueued_at     timestamptz not null default now(),
  -- A claim is a lease, not a lock: a worker that dies holding one lets it lapse and the row is
  -- claimed again. An enqueue after a claim clears it, so an edit made while the old text was
  -- being embedded is embedded again rather than lost.
  claimed_until   timestamptz
);

create index embed_pending_order on retrieval.embed_pending (enqueued_at);

comment on table retrieval.embed_pending is
  'Derived queue (§64A, KF-SAS-RQ-225): records whose vectors the retrieval engine has yet to be '
  'given. Rebuildable by enqueueing every object; no application grant.';

alter table retrieval.embed_pending enable row level security;
alter table retrieval.embed_pending force row level security;
revoke all on retrieval.embed_pending from public;

/** Queue the named objects for embedding. Unknown ids are ignored. Returns how many were queued. */
create function retrieval.enqueue_embedding(p_object_ids uuid[]) returns integer
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
    set enqueued_at = now(), claimed_until = null;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

/**
 * Claim up to `p_limit` queued records for `p_lease_seconds`, with the text to embed.
 *
 * The text is what search already indexes — title and body from search.document — so what is
 * semantically searchable is exactly what is lexically searchable, and nothing more.
 */
create function retrieval.claim_embeddings(p_limit integer, p_lease_seconds integer)
returns table (object_id uuid, organization_id uuid, text text, claimed_until timestamptz)
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
         set claimed_until = now() + make_interval(secs => p_lease_seconds)
        from claimable c
       where p.object_id = c.object_id
      returning p.object_id, p.organization_id, p.claimed_until
    )
    select c.object_id, c.organization_id,
           coalesce(d.title || E'\n\n' || d.body, o.title) as text,
           c.claimed_until
      from claimed c
      join core.object o on o.id = c.object_id
      left join search.document d on d.object_id = c.object_id
     order by c.object_id;
end
$$;

/**
 * Finish one claimed record. Removes it only if the claim is still the one the worker holds: a
 * record re-enqueued while being embedded stays queued, because the text that was sent is stale.
 */
create function retrieval.complete_embedding(p_object_id uuid, p_claimed_until timestamptz)
returns boolean
language sql
security definer
set search_path = pg_catalog, retrieval
as $$
  with removed as (
    delete from retrieval.embed_pending
     where object_id = p_object_id and claimed_until = p_claimed_until
    returning 1
  )
  select exists (select 1 from removed)
$$;

revoke all on function retrieval.enqueue_embedding(uuid[]) from public;
revoke all on function retrieval.claim_embeddings(integer, integer) from public;
revoke all on function retrieval.complete_embedding(uuid, timestamptz) from public;
grant execute on function retrieval.enqueue_embedding(uuid[]) to kf_worker;
grant execute on function retrieval.claim_embeddings(integer, integer) to kf_worker;
grant execute on function retrieval.complete_embedding(uuid, timestamptz) to kf_worker;

-- migrate:down

drop function retrieval.complete_embedding(uuid, timestamptz);
drop function retrieval.claim_embeddings(integer, integer);
drop function retrieval.enqueue_embedding(uuid[]);
drop table retrieval.embed_pending;
