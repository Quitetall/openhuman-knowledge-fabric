-- migrate:up

-- Readiness must verify the complete cluster-global audit chain, but kf_app cannot read all
-- audit rows directly under object-scoped RLS. Return only the break count and total; the log
-- and its event payloads remain outside the application's reach.
create function core.readiness_audit_chain()
returns table (breaks bigint, total bigint)
language sql
stable
security definer
set search_path = pg_catalog, core
as $$
  with linked as (
    select seq,
           prev_digest,
           lag(digest) over (order by seq) as expected_prev
      from core.audit_event
  )
  select count(*) filter (
           where (expected_prev is null and prev_digest <> repeat('0', 64))
              or (expected_prev is not null and prev_digest <> expected_prev)
         )::bigint,
         count(*)::bigint
    from linked
$$;

revoke all on function core.readiness_audit_chain() from public;
grant execute on function core.readiness_audit_chain() to kf_app, kf_worker;

comment on function core.readiness_audit_chain is
  'Global audit-chain break and event counts for readiness; never exposes audit rows.';

-- migrate:down
-- kf:forward-only audit-chain aggregate is required for truthful M6 readiness; reverting would let scoped visibility masquerade as an intact empty log
