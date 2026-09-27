-- migrate:up

-- The search index rebuilds in batches, and a stopped rebuild resumes (§64, SAS §2.10).
--
-- `search.rebuild()` deleted every row and re-indexed every record in one statement. On the
-- multi-organization fixture (54 733 records, 2026-09-25) that statement outlasted the statement
-- budget every login runs under, so the function that keeps the index disposable could not run
-- where it was most needed; the fixture loaders worked around it by indexing a named subset.
--
-- `search.rebuild_batch(after, limit)` re-indexes the next `limit` records in id order after
-- `after` and returns how many it indexed and the last id, so a caller runs one short
-- transaction per batch and resumes from the last id it saw. Nothing is deleted first: a row is
-- replaced by `search.index_object`, which is idempotent, and a row whose record is gone was
-- already removed by the foreign key's cascade. A rebuild that stops half way therefore leaves an
-- index in which every row is either rebuilt or as it was, never missing.
--
-- `search.rebuild()` stays, for callers that hold no statement budget (tests, an operator at a
-- psql prompt): it now runs the same batches in one statement and deletes nothing.

create function search.rebuild_batch(p_after uuid, p_limit integer)
returns table (indexed integer, last_object uuid)
language plpgsql
security definer
set search_path = core, search, registry, pg_catalog
as $$
declare
  v_id    uuid;
  v_count integer := 0;
  v_last  uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'search.rebuild_batch: limit must be between 1 and 10000, not %', p_limit
      using errcode = '22023';
  end if;
  for v_id in
    select o.id from core.object o
     where p_after is null or o.id > p_after
     order by o.id
     limit p_limit
  loop
    perform search.index_object(v_id);
    v_count := v_count + 1;
    v_last := v_id;
  end loop;
  return query select v_count, v_last;
end
$$;

create or replace function search.rebuild() returns bigint
language plpgsql
security definer
set search_path = core, search, registry, pg_catalog
as $$
declare
  v_total bigint := 0;
  v_after uuid;
  v_batch record;
begin
  loop
    select * into v_batch from search.rebuild_batch(v_after, 1000);
    exit when v_batch.indexed = 0;
    v_total := v_total + v_batch.indexed;
    v_after := v_batch.last_object;
  end loop;
  return v_total;
end
$$;

revoke execute on function search.rebuild_batch(uuid, integer) from public;
revoke execute on function search.rebuild() from public;
-- The worker's login only, as for search.rebuild(): a rebuild is an operator action, and an
-- application that could trigger one could make itself very slow on request.
grant execute on function search.rebuild_batch(uuid, integer) to kf_worker;
grant execute on function search.rebuild() to kf_worker;

comment on function search.rebuild_batch(uuid, integer) is
  'Re-index the next p_limit records after p_after in id order; returns the count and the last '
  'id, so a rebuild runs in short transactions and resumes (20260926100100).';

-- migrate:down

drop function search.rebuild_batch(uuid, integer);

create or replace function search.rebuild() returns bigint
language plpgsql
security definer
set search_path = core, search, registry, pg_catalog
as $$
declare
  v_count bigint := 0;
  v_id uuid;
begin
  delete from search.document;
  for v_id in select id from core.object loop
    perform search.index_object(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

revoke execute on function search.rebuild() from public;
grant execute on function search.rebuild() to kf_worker;
