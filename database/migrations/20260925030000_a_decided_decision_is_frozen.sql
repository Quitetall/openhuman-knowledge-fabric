-- migrate:up

-- KF-DEC-001: "Accepted or rejected decision records are immutable; supersession creates a new
-- decision record."
--
-- Half of that was enforced. The lifecycle half is the state machine: `accepted` has one exit,
-- `supersede_decision`, and `rejected`, `superseded` and `withdrawn` are terminal, so no act can
-- move a decided record anywhere else, and `core.enforce_state_transition` refuses a direct write
-- that tries. The ADR body is append-only with one accepted body per decision
-- (20260815000100). What nothing stopped was the record's own words changing afterwards: a
-- session with a transaction context could rename an accepted decision, and add alternatives it
-- never considered, while its state, its audit trail and every citation of it stayed put. The
-- rule-ledger test recorded exactly that gap ("nothing yet freezes the CONTENT of an accepted
-- decision, which is the half of the rule that matters").
--
-- So a decided decision's title is frozen, and its alternatives are closed. "Decided" is every
-- state past `proposed`: accepted, rejected, superseded, withdrawn. A lifecycle move is still
-- allowed — supersession is how an accepted decision is replaced — and so is every envelope
-- column that is not the decision's content (an enterprise identifier is allocated to an
-- accepted ADR by a separate act, ADR 0018).
--
-- Triggers, not privileges, for the reason 20260811000800 gives: they bind the owner too. The
-- name sorts after the three write guards so a context-free or version-skipping write is refused
-- for that first, with the clearer message.

create function core.refuse_decided_decision_rewrite() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if old.object_type = 'decision_record'
     and old.lifecycle_state in ('accepted', 'rejected', 'superseded', 'withdrawn')
     and new.title is distinct from old.title then
    raise exception 'KF-DEC-001: a % decision is immutable; supersede it with a new decision record',
      old.lifecycle_state
      using errcode = 'check_violation',
            hint = 'propose_decision, then supersede_decision on this one.';
  end if;
  return new;
end
$$;

create trigger object_guard_4_decided_decision
  before update of title on core.object
  for each row execute function core.refuse_decided_decision_rewrite();

create function engineering.refuse_alternative_after_decision() returns trigger
language plpgsql
set search_path = pg_catalog, core, engineering
as $$
declare
  v_state text;
begin
  select lifecycle_state into v_state from core.object where id = new.decision_id;
  if v_state in ('accepted', 'rejected', 'superseded', 'withdrawn') then
    raise exception 'KF-DEC-001: a % decision is immutable; its alternatives were settled when it was decided',
      v_state
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger decision_alternative_before_decision
  before insert on engineering.decision_alternative
  for each row execute function engineering.refuse_alternative_after_decision();

-- migrate:down

drop trigger decision_alternative_before_decision on engineering.decision_alternative;
drop function engineering.refuse_alternative_after_decision();
drop trigger object_guard_4_decided_decision on core.object;
drop function core.refuse_decided_decision_rewrite();
