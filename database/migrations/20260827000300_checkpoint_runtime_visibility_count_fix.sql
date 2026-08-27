-- migrate:up

-- The first aggregate revision selected from audit_event for both values, so a populated log
-- with zero signed checkpoints looked covered. Keep checkpoint cardinality an independent
-- scalar subquery; the two numbers answer different integrity questions.
create or replace function core.readiness_checkpoint_coverage()
returns table (uncovered bigint, checkpoints bigint, last_signed_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, core
as $$
  select count(*) filter (
           where not exists (
             select 1 from core.audit_checkpoint c
              where e.seq between c.from_seq and c.to_seq
           )
         )::bigint,
         (select count(*)::bigint from core.audit_checkpoint),
         (select max(recorded_at) from core.audit_checkpoint)
    from core.audit_event e
$$;

-- migrate:down
-- kf:forward-only correction preserves truthful checkpoint readiness; reverting would let audit-event count masquerade as signed-checkpoint count
