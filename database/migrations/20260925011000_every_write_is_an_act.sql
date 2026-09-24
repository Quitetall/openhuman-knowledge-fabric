-- migrate:up

-- A row the application or the worker writes belongs to an act the ledger records
-- (KF-SAS-RQ-050, RQ-011, RQ-101b).
--
-- 20260923000200 made the ledger and the chain agree with the sealed context. The domain tables
-- did not have to: `kf_app` holds column UPDATE on `quality.capa (root_cause, …)`,
-- `quality.nonconformity`, `quality.controlled_document (effective_from, content_version)`,
-- `quality.complaint`, `quality.supplier`, `quality.equipment` (20260811001400), and INSERT or
-- UPDATE on most of work, engineering, product, content and finance, each guarded only by an
-- "envelope visible" policy. A compromised API with a bound principal could rewrite a CAPA's root
-- cause or a document's effective date, and nothing in `core.action` or `core.audit_event` would
-- say that anyone had. The worker's UPDATE of `quality.federated_reference.verified_at` never
-- went near the dispatcher either.
--
-- THE GUARD. Every table `kf_app` or `kf_worker` can write carries two triggers:
--
--   * `zz_written_under_an_act`, BEFORE each row (`core.action_context_required`): the sealed
--     context must name an action (`core.current_action_id()`), and that id is noted, sealed, for
--     the end of the transaction. Named to fire LAST among a table's BEFORE triggers, so the
--     older, more specific guards (`object_guard_1_context`, …) still refuse with their own words;
--   * `written_act_is_recorded` (`core.action_context_recorded`), a constraint trigger DEFERRED
--     to commit: every noted action must
--     be in `core.action`, performed by the sealed actor in the bound organization — and, for an
--     APPLICATION session, recorded in THIS transaction.
--
-- Deferred because the dispatcher materializes created records before it writes the ledger row
-- (`prepareActionState` → `applyAction`); the act and its writes commit together or not at all.
-- "This transaction" because an old act of the same principal must not license new writes; the
-- ledger row carries `recorded_at = now()`, which is the transaction's start. A SERVICE session
-- (the worker) may complete an act already recorded — the document compiler writes its result
-- under the request's act, from the outbox, after that act committed — but only an act of the
-- actor it bound, in that organization. ADMINISTRATOR sessions are exempt, as everywhere since
-- 20260923000200: bootstrap, grant-authority and fixtures write through the owner credential,
-- which could drop the trigger anyway.
--
-- THE EXEMPTIONS are rows in `core.write_guard_exemption`, each with its reason, and
-- `tests/database/write-guards.test.ts` pins the list: a table added later that the application
-- can write is guarded, or the test names it. Nothing else is exempt.
--
-- WHAT THIS DOES NOT DO. It proves a write happened inside a transaction that recorded an act by
-- the bound principal. It does not prove the act's targets cover the row, nor that the act's
-- type is one that writes that table; a compromised API can still record a true-shaped act and
-- write beside it — but no longer without a ledger row, attributed to a real person who
-- presented a token, that says it acted.

create table core.write_guard_exemption (
  table_name text not null,
  operation  text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  reason     text not null check (length(btrim(reason)) >= 40),
  primary key (table_name, operation)
);

comment on table core.write_guard_exemption is
  'Writes by kf_app or kf_worker that are NOT required to belong to a recorded act, each with its '
  'reason. Pinned by tests/database/write-guards.test.ts; everything else carries '
  'zz_written_under_an_act and written_act_is_recorded.';

revoke all on core.write_guard_exemption from public;

insert into core.write_guard_exemption (table_name, operation, reason) values
  ('core.action', 'INSERT',
   'It is the act. Held to the sealed context by action_scoped_insert and to act authority by action_requires_act_authority.'),
  ('core.audit_event', 'INSERT',
   'The act''s own chain link. core.enforce_audit_chain_head requires its action to be in the ledger and, outside an administrator session, to be the action the context names.'),
  ('core.outbox', 'UPDATE',
   'Delivery bookkeeping: the worker marks delivered_at (its only column) after running the task an act enqueued; the row itself is inserted inside that act.'),
  ('quality.federated_reference', 'UPDATE',
   'verified_at is the only updatable column: the drift check''s observation that the pinned bytes still hash as recorded, forced to the database clock by federated_reference_verified_now.'),
  ('content.master_record_link_access', 'INSERT',
   'The access log of a shared-link bearer, who is nobody the system knows and so cannot act: an append-only observation of a read, bound to the link''s own organization.');

-- Note the act a row is written under. SECURITY DEFINER: only the seal may write a kf.* setting.
create function core.action_context_required() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_action text;
  v_noted  text;
begin
  if core.session_is_administrator() then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  v_action := core.current_action_id()::text;
  if v_action is null then
    raise exception 'a write to %.% must be performed by an act, and no action is bound',
      tg_table_schema, tg_table_name
      using errcode = 'insufficient_privilege',
            hint = 'Dispatch an action; the database refuses domain writes the ledger does not record.';
  end if;
  v_noted := coalesce(core.sealed_setting('kf.written_actions', true), '');
  if position(v_action in v_noted) = 0 then
    -- Dropping the verified mark ('+') makes the commit-time check look again.
    v_noted := ltrim(v_noted, '+');
    perform core.seal_setting('kf.written_actions',
                              case when v_noted = '' then v_action else v_noted || ',' || v_action end,
                              true);
  end if;
  return case tg_op when 'DELETE' then old else new end;
end
$$;

-- At commit: every noted act is in the ledger. Once verified, the list carries a '+' and the
-- remaining rows' checks are one comparison.
create function core.action_context_recorded() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_noted  text;
  v_action text;
begin
  if core.session_is_administrator() then
    return null;
  end if;
  v_noted := core.sealed_setting('kf.written_actions', true);
  if v_noted is null then
    raise exception 'a write to %.% was made with no act noted', tg_table_schema, tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  if left(v_noted, 1) = '+' then
    return null;
  end if;
  foreach v_action in array string_to_array(v_noted, ',') loop
    if not exists (
      select 1 from core.action a
       where a.id = v_action::uuid
         and a.actor_id = core.current_actor_or_null()
         and a.organization_id = core.current_organization()
         and (a.recorded_at = transaction_timestamp() or not core.session_is_application())
    ) then
      raise exception 'action % wrote to %.% but is not an act this transaction recorded for its actor',
        v_action, tg_table_schema, tg_table_name
        using errcode = 'insufficient_privilege',
              hint = 'The ledger row must be written in the same transaction, by the dispatcher.';
    end if;
  end loop;
  perform core.seal_setting('kf.written_actions', '+' || v_noted, true);
  return null;
end
$$;

revoke all on function core.action_context_required() from public;
revoke all on function core.action_context_recorded() from public;

-- Attach both triggers to every table kf_app or kf_worker can write, for each operation not
-- exempted. Idempotent, so a later migration that grants a new write calls it again.
create function core.install_action_context_guards() returns integer
language plpgsql
set search_path = pg_catalog, core
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    -- Qualified by hand: `oid::regclass::text` drops the schema of anything on this function's
    -- search_path, and `outbox` never matches the exemption `core.outbox`.
    select format('%I.%I', n.nspname, c.relname) as tbl,
           string_agg(op.name, ' or ' order by op.name) as ops
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as op(name)
     where c.relkind in ('r', 'p')
       and n.nspname not in ('pg_catalog', 'information_schema')
       and n.nspname !~ '^pg_'
       and exists (
         select 1 from (values ('kf_app'), ('kf_worker')) as w(role)
          where has_table_privilege(w.role, c.oid, op.name)
             or (op.name <> 'DELETE' and has_any_column_privilege(w.role, c.oid, op.name)))
       and not exists (
         select 1 from core.write_guard_exemption e
          where e.table_name = format('%I.%I', n.nspname, c.relname) and e.operation = op.name)
     group by n.nspname, c.relname
  loop
    execute format('drop trigger if exists zz_written_under_an_act on %s', r.tbl);
    execute format('drop trigger if exists written_act_is_recorded on %s', r.tbl);
    execute format(
      'create trigger zz_written_under_an_act before %s on %s '
      'for each row execute function core.action_context_required()', r.ops, r.tbl);
    execute format(
      'create constraint trigger written_act_is_recorded after %s on %s '
      'deferrable initially deferred '
      'for each row execute function core.action_context_recorded()', r.ops, r.tbl);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

revoke all on function core.install_action_context_guards() from public;

select core.install_action_context_guards();

-- The one exempted update, made honest: a verification observation is stamped by the database's
-- clock, as an access-grant revocation is (20260923000200), so it cannot be backdated or
-- post-dated by whoever writes it.
create function quality.federated_reference_verified_now() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if not core.session_is_administrator() then
    new.verified_at := now();
  end if;
  return new;
end
$$;

revoke all on function quality.federated_reference_verified_now() from public;

create trigger federated_reference_verified_now
  before update on quality.federated_reference
  for each row execute function quality.federated_reference_verified_now();

-- migrate:down

-- Reversible, as 20260924000100 is: every release before this one writes domain rows only
-- through the dispatcher or a recorded act, so rolling back past it re-opens exactly the gap
-- described above and breaks nothing.
drop trigger federated_reference_verified_now on quality.federated_reference;
drop function quality.federated_reference_verified_now();

do $$
declare
  r record;
begin
  for r in
    select distinct tgrelid::regclass::text as tbl
      from pg_trigger
     where tgname in ('zz_written_under_an_act', 'written_act_is_recorded')
       and not tgisinternal
  loop
    execute format('drop trigger if exists zz_written_under_an_act on %s', r.tbl);
    execute format('drop trigger if exists written_act_is_recorded on %s', r.tbl);
  end loop;
end
$$;

drop function core.install_action_context_guards();
drop function core.action_context_recorded();
drop function core.action_context_required();
drop table core.write_guard_exemption;
