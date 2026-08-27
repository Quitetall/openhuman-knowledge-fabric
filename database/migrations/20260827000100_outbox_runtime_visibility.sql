-- migrate:up

-- M6 runtime delivery runs as the dedicated worker role, without a person or organization
-- context. The ordinary organization policy therefore admits no rows to it. Give that role
-- exactly the queue reach it already needs: read and delivery-mark every outbox row, but no
-- insert or payload-derived domain write. The handlers themselves remain the authority
-- boundary for their narrow derived effects.
create policy outbox_worker_read on core.outbox
  for select to kf_worker
  using (true);

create policy outbox_worker_update on core.outbox
  for update to kf_worker
  using (true)
  with check (true);

-- Readiness needs a global backlog number, while kf_app must not gain global payload access.
-- This definer returns only count and age, never action ids, topics or payloads. A missing
-- context cannot turn a monitoring query into a cross-organization record reader.
create function core.readiness_outbox_backlog()
returns table (pending bigint, oldest_seconds bigint)
language sql
stable
security definer
set search_path = pg_catalog, core
as $$
  select count(*)::bigint,
         coalesce(extract(epoch from (now() - min(created_at)))::bigint, 0::bigint)
    from core.outbox
   where delivered_at is null
$$;

revoke all on function core.readiness_outbox_backlog() from public;
grant execute on function core.readiness_outbox_backlog() to kf_app, kf_worker;

comment on function core.readiness_outbox_backlog is
  'Global outbox count and age for readiness only; never exposes payload or action identity.';

-- migrate:down
-- kf:forward-only worker delivery and aggregate readiness visibility are required for M6; reverting would make the production worker blind and readiness falsely green
