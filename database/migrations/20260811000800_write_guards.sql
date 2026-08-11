-- migrate:up

-- Write guards: make the action service the ONLY way a controlled record changes.
--
-- Until now the dispatcher was the only *intended* path, not the only *possible* one.
-- kf_app held UPDATE on core.object, no trigger consulted the transaction context, and
-- core.current_actor() — written precisely to refuse a context-free write — was never
-- called by anything. A direct
--
--   update core.object set lifecycle_state = 'accepted' where id = ...
--
-- would have moved a record with no action, no audit event and no actor. The guarantee was
-- a convention, and a convention is not a control.
--
-- Three triggers close it. They bind the OWNER and every superuser too, because they are
-- triggers rather than privileges: a privilege can be re-granted by accident, and a trigger
-- has to be dropped deliberately — which `log_statement=ddl` records.

-- PostgreSQL fires BEFORE triggers in alphabetical order by name, so the numbers in these
-- names are load-bearing rather than decorative. The context guard must answer first: it is
-- the most fundamental failure and produces the clearest message. Without the ordering, a
-- context-free write is refused by whichever guard happens to sort earlier, and the operator
-- is told about a transition problem when the real fault is a missing actor.

-- ── 1. no controlled write without a transaction context ────────────────────────────────

create or replace function core.require_transaction_context() returns trigger
language plpgsql
as $$
begin
  -- Raises if unset. The message names the remedy, because the person hitting this is
  -- usually reaching for psql to fix something quickly.
  perform core.current_actor();
  return new;
end
$$;

create trigger object_guard_1_context
  before insert or update on core.object
  for each row execute function core.require_transaction_context();

create trigger relation_guard_1_context
  before insert or update on core.relation
  for each row execute function core.require_transaction_context();

-- ── 2. a lifecycle move must be one the ontology permits, for the action performing it ───

create or replace function core.enforce_state_transition() returns trigger
language plpgsql
as $$
declare
  v_action_id uuid := core.current_action_id();
  v_action_type text;
begin
  if new.lifecycle_state = old.lifecycle_state then
    return new;
  end if;

  if v_action_id is null then
    raise exception 'lifecycle change on % requires an action', old.id
      using errcode = 'insufficient_privilege',
            hint = 'Route the change through the action service; a state does not move on its own.';
  end if;

  -- The action must already exist. The dispatcher writes core.action BEFORE moving the
  -- object for exactly this reason: without it the trigger cannot know which transition it
  -- is being asked to authorize, and could only check that SOME action permits the move.
  select action_type into v_action_type from core.action where id = v_action_id;
  if v_action_type is null then
    raise exception 'action % is not recorded', v_action_id
      using errcode = 'foreign_key_violation',
            hint = 'Write the action row before applying its effect.';
  end if;

  if not exists (
    select 1 from registry.state_transition
     where object_type = new.object_type
       and from_state  = old.lifecycle_state
       and to_state    = new.lifecycle_state
       and action_id   = v_action_type
  ) then
    raise exception
      '% cannot move % from % to %', v_action_type, new.object_type,
      old.lifecycle_state, new.lifecycle_state
      using errcode = 'check_violation',
            hint = 'The ontology defines no such transition for this action.';
  end if;

  return new;
end
$$;

create trigger object_guard_2_transition
  before update on core.object
  for each row execute function core.enforce_state_transition();

-- ── 3. row_version moves by exactly one ─────────────────────────────────────────────────

create or replace function core.enforce_row_version() returns trigger
language plpgsql
as $$
begin
  -- Optimistic concurrency only works if the version actually advances. A writer that left
  -- it alone would let every other reader's stale version silently keep validating.
  if new.row_version <> old.row_version + 1 then
    raise exception 'row_version must advance by exactly 1 (% -> %)', old.row_version, new.row_version
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger object_guard_3_row_version
  before update on core.object
  for each row execute function core.enforce_row_version();

-- ── 4. who may set context ──────────────────────────────────────────────────────────────

-- PostgreSQL grants EXECUTE on a new function to PUBLIC. Without revoking it, kf_readonly
-- and kf_auditor could declare themselves any actor they liked.
revoke execute on function core.set_transaction_context(uuid, uuid, uuid, text) from public;
grant  execute on function core.set_transaction_context(uuid, uuid, uuid, text)
  to kf_app, kf_worker;

-- Readers need to declare their scope, so they keep this one. See the note below on what
-- that does and does not buy.
revoke execute on function core.set_access_context(uuid, text) from public;
grant  execute on function core.set_access_context(uuid, text)
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor;

-- Identity may not change mid-transaction. Without this, one transaction could commit two
-- actions attributed to two different people, and the audit trail would be true in each row
-- and false as a whole.
create or replace function core.set_transaction_context(
  p_actor uuid,
  p_acting_role uuid,
  p_action_id uuid,
  p_request_id text
) returns void
language plpgsql
as $$
declare v_existing text := current_setting('kf.actor', true);
begin
  if v_existing is not null and v_existing <> '' and v_existing <> p_actor::text then
    raise exception 'transaction context already set to a different actor'
      using errcode = 'insufficient_privilege',
            hint = 'One transaction, one actor. Start a new transaction for a different one.';
  end if;
  perform set_config('kf.actor', p_actor::text, true);
  perform set_config('kf.acting_role', p_acting_role::text, true);
  perform set_config('kf.action_id', p_action_id::text, true);
  perform set_config('kf.request_id', coalesce(p_request_id, ''), true);
end
$$;

revoke execute on function core.set_transaction_context(uuid, uuid, uuid, text) from public;
grant  execute on function core.set_transaction_context(uuid, uuid, uuid, text)
  to kf_app, kf_worker;

-- ── 5. kf_backup could not read anything ────────────────────────────────────────────────

-- Its stated job is pg_dump, which needs SELECT on every table. It had USAGE on the schemas
-- and nothing else, so a backup would have failed on the first table — the kind of fault
-- that stays invisible until the day it is needed.
grant select on all tables in schema registry, core, org to kf_backup;

comment on trigger object_guard_1_context on core.object is
  'Numbered so it fires FIRST: BEFORE triggers run in alphabetical order, and a missing '
  'actor should be reported as a missing actor, not as whatever the next guard notices.';
comment on function core.require_transaction_context is
  'Refuses a controlled write with no transaction context. Binds the owner and superusers '
  'too: this is a trigger, not a privilege, and a privilege can be re-granted by accident.';
comment on function core.enforce_state_transition is
  'A lifecycle move must be one the ontology defines FOR THE ACTION performing it. This is '
  'why the dispatcher writes core.action before applying its effect.';

-- migrate:down

drop trigger if exists object_guard_3_row_version on core.object;
drop trigger if exists object_guard_2_transition on core.object;
drop trigger if exists relation_guard_1_context on core.relation;
drop trigger if exists object_guard_1_context on core.object;
drop function if exists core.enforce_row_version();
drop function if exists core.enforce_state_transition();
drop function if exists core.require_transaction_context();
