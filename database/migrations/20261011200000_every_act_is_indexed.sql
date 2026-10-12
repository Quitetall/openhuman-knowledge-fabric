-- migrate:up

-- Every act and every record it writes reaches the search outbox, whoever performed it
-- (SAS §100.68, KF-SAS-RQ-121).
--
-- WHAT WAS WRONG. The dispatcher wrote the act's outbox row itself, in `finalizeAction`
-- (@kf/actions), right after the act's audit link. The owner's commands — `kf
-- bootstrap-organization`, `grant-authority`, `invite`, `revoke-identity`, `retire-organization`,
-- `declare-service-actor` — record their acts by hand on the owner credential (the bootstrap-tier
-- exception to the write seam) and append the audit link through the same `appendAuditEvent`,
-- but nothing made them write the outbox row, and none did. So the organization, the person, the
-- role assignment and the invitation an owner command created were not searchable until someone
-- ran `select search.rebuild();`. A list of "commands that must remember the outbox" is the thing
-- that had already gone stale once.
--
-- THE FIX, in two places that no writer can step around.
--
--   1. `audit_event_emits_outbox`, AFTER INSERT on `core.audit_event`: an act's audit link
--      emits its outbox row — topic `kf.<action_type>`, payload `{action_id, targets}` with the
--      targets the ledger row names, exactly what `finalizeAction` wrote — unless the act
--      already has one under that topic. Every act has an audit link (the chain is how an act is
--      known to have happened), so every act, dispatched or owner-recorded, is delivered.
--      `finalizeAction` no longer writes the row; the database does, once.
--
--   2. `written_record_is_indexed`, a constraint trigger DEFERRED to commit, AFTER INSERT OR
--      UPDATE on `core.object`: a record written in a transaction that is not already among the
--      targets of an outbox row that transaction emitted gets one of its own, topic
--      `kf.record_written`, under the act the context names or, when none is bound (the owner's
--      bootstrap binds only an organization), under the act this transaction already emitted.
--      An act's ledger targets are what it acted ON; the records it wrote along the way (the
--      founding role assignment `grant-authority` creates, a compiled view the worker records
--      under a request's act) are not always among them, and they were invisible too.
--
-- WHAT IS STILL NOT DELIVERED. A record written in a transaction that records no act and binds
-- none: migrations and the fixture loaders, on the owner credential. Those index what they load
-- or run `search.rebuild()`, as before; the index stays derived and rebuildable either way.
--
-- Both functions are SECURITY DEFINER: the worker's login holds no INSERT on the outbox
-- (20260827000100), and a compiled view it records under a request's act still has to be found.
-- Neither takes an argument; each writes one row derived from the row that fired it.
--
-- A restore runs with user triggers off (packages/export importer), so importing a ledger and its
-- exported outbox does not emit a second row for every historical act.

create function core.emit_act_outbox() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_topic   text := 'kf.' || new.action_type;
  v_targets uuid[];
begin
  -- Looked for among this transaction's undelivered rows only (`outbox_undelivered`): an act's
  -- row is written in the transaction that records it, and the outbox is never scanned whole.
  if exists (
    select 1 from core.outbox o
     where o.delivered_at is null
       and o.created_at = transaction_timestamp()
       and o.action_id = new.action_id
       and o.topic = v_topic
  ) then
    return null;
  end if;
  select a.target_ids into v_targets from core.action a where a.id = new.action_id;
  insert into core.outbox (action_id, topic, payload)
  values (
    new.action_id,
    v_topic,
    jsonb_build_object(
      'action_id', new.action_id::text,
      'targets', to_jsonb(coalesce(v_targets, array[]::uuid[]))
    )
  );
  return null;
end
$$;

revoke all on function core.emit_act_outbox() from public;

create trigger audit_event_emits_outbox
  after insert on core.audit_event
  for each row execute function core.emit_act_outbox();

comment on trigger audit_event_emits_outbox on core.audit_event is
  'SAS §100.68: an act''s audit link emits its kf.<action_type> outbox row, so an act recorded '
  'by the owner''s commands is delivered to search as a dispatched one is (20261011200000).';

create function core.index_written_record() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_action uuid;
begin
  -- Already named by a row this transaction emitted. `created_at` defaults to now(), the
  -- transaction's instant, and undelivered rows are what `outbox_undelivered` indexes.
  if exists (
    select 1 from core.outbox o
     where o.delivered_at is null
       and o.created_at = transaction_timestamp()
       and o.payload -> 'targets' ? new.id::text
  ) then
    return null;
  end if;

  v_action := core.current_action_id();
  if v_action is not null and not exists (select 1 from core.action a where a.id = v_action) then
    v_action := null;
  end if;
  if v_action is null then
    select o.action_id into v_action
      from core.outbox o
     where o.delivered_at is null
       and o.created_at = transaction_timestamp()
     order by o.id desc
     limit 1;
  end if;
  if v_action is null then
    -- No act in this transaction: an owner-credential load outside the ledger. Rebuild covers it.
    return null;
  end if;

  insert into core.outbox (action_id, topic, payload)
  values (
    v_action,
    'kf.record_written',
    jsonb_build_object('action_id', v_action::text, 'targets', jsonb_build_array(new.id::text))
  );
  return null;
end
$$;

revoke all on function core.index_written_record() from public;

create constraint trigger written_record_is_indexed
  after insert or update on core.object
  deferrable initially deferred
  for each row execute function core.index_written_record();

comment on trigger written_record_is_indexed on core.object is
  'SAS §100.68: at commit, a record written under an act and not among the targets of an outbox '
  'row its transaction emitted gets a kf.record_written row of its own (20261011200000).';

-- migrate:down

drop trigger written_record_is_indexed on core.object;
drop function core.index_written_record();
drop trigger audit_event_emits_outbox on core.audit_event;
drop function core.emit_act_outbox();
