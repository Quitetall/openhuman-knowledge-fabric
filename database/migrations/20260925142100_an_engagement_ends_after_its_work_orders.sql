-- migrate:up

-- KF-ENG-001: an engagement is not closed or terminated while a work order under it is still
-- open, and no work order is placed under an engagement that has ended (ontology/rules.yaml).
--
-- `close_engagement` and `terminate_engagement` (20260924 engagement lifecycle) moved the state
-- and nothing else, so an engagement could be closed with an active order still drawing on it:
-- the agreement the order is executed under would read as ended while work, acceptance and
-- invoicing against it continued. The work-control precondition refuses the act with a reason a
-- caller can act on; these triggers are the authority, because a precondition sees only what the
-- caller may read and cannot hold a lock across the dispatcher.
--
-- "Open" and "ended" are the ontology's, not a list here: a state is ended exactly when
-- registry.object_state marks it terminal for its type (work_order: closed, cancelled,
-- terminated; engagement: closed, terminated). The linkage is work.work_order.engagement_id
-- (KF-WORK-002: exactly one engagement per order).
--
-- The two triggers meet on the org.engagement row: the state change takes it FOR UPDATE, a new
-- or re-pointed order FOR SHARE, so an order placed while the engagement closes waits for the
-- close and then sees it.

create function work.assert_engagement_ends_after_its_orders() returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_open bigint;
begin
  if not exists (
    select 1 from registry.object_state s
     where s.object_type = 'engagement' and s.state = new.lifecycle_state and s.is_terminal
  ) then
    return new;
  end if;

  perform 1 from org.engagement e where e.id = new.id for update;

  select count(*) into v_open
    from work.work_order wo
    join core.object o on o.id = wo.id
   where wo.engagement_id = new.id
     and not exists (
       select 1 from registry.object_state s
        where s.object_type = 'work_order' and s.state = o.lifecycle_state and s.is_terminal);

  if v_open > 0 then
    raise exception
      'KF-ENG-001: engagement % cannot become % while % work order(s) under it are open',
      new.id, new.lifecycle_state, v_open
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger engagement_ends_after_its_orders
  before update of lifecycle_state on core.object
  for each row
  when (new.object_type = 'engagement'
        and new.lifecycle_state is distinct from old.lifecycle_state)
  execute function work.assert_engagement_ends_after_its_orders();

create function work.assert_order_under_live_engagement() returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_state text;
begin
  perform 1 from org.engagement e where e.id = new.engagement_id for share;

  select o.lifecycle_state into v_state from core.object o where o.id = new.engagement_id;

  if exists (
    select 1 from registry.object_state s
     where s.object_type = 'engagement' and s.state = v_state and s.is_terminal
  ) then
    raise exception
      'KF-ENG-001: engagement % is %; a work order cannot be placed under it',
      new.engagement_id, v_state
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger order_under_live_engagement
  before insert or update of engagement_id on work.work_order
  for each row
  execute function work.assert_order_under_live_engagement();

revoke all on function work.assert_engagement_ends_after_its_orders() from public;
revoke all on function work.assert_order_under_live_engagement() from public;

-- migrate:down

drop trigger order_under_live_engagement on work.work_order;
drop function work.assert_order_under_live_engagement();
drop trigger engagement_ends_after_its_orders on core.object;
drop function work.assert_engagement_ends_after_its_orders();
