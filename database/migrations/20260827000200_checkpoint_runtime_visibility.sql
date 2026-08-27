-- migrate:up

-- Checkpoint coverage has the same global shape as outbox health. The signer role owns
-- checkpoint rows, while the application readiness process must be able to say "no checkpoint"
-- rather than turning a missing SELECT grant into an opaque unknown. Return aggregate integrity
-- facts only; audit and checkpoint rows remain outside kf_app's direct reach.
create function core.readiness_checkpoint_coverage()
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
         count(*)::bigint,
         (select max(recorded_at) from core.audit_checkpoint)
    from core.audit_event e
$$;

revoke all on function core.readiness_checkpoint_coverage() from public;
grant execute on function core.readiness_checkpoint_coverage() to kf_app, kf_worker;

comment on function core.readiness_checkpoint_coverage is
  'Global checkpoint coverage aggregates for readiness; never exposes audit or checkpoint rows.';

-- migrate:down
-- kf:forward-only checkpoint coverage aggregate is required for truthful M6 readiness; reverting would turn missing checkpoints into opaque unknowns
