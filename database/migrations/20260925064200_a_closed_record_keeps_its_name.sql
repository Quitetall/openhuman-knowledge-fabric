-- migrate:up

-- A closed record keeps the fields that say what it is (KF-DEC-001, SAS §14.3, §19).
--
-- WHAT WAS WRONG. KF-DEC-001 — "accepted or rejected decision records are immutable;
-- supersession creates a new decision record" — was enforced only by an action precondition
-- (`assertDecisionMutable` on accept, reject and correct_record) and the transition guard, which
-- watches `lifecycle_state` and nothing else. `kf_app` holds UPDATE on every column of
-- `core.object`. A session with a principal bound and an act recorded — any act, since
-- 20260925011000 checks that an act exists, not what it may write — could run
--
--   update core.object set title = 'something else', row_version = row_version + 1
--    where id = <an accepted decision>
--
-- and the record would say a different thing from the one the organization accepted, with only a
-- generic act in the ledger beside it. The same held for every record in a terminal state.
--
-- THE GUARD. Once a record is CLOSED its identity-bearing fields are fixed, for every session,
-- the owner included (a trigger, like the other object guards, not a privilege):
--
--   title, object_type, organization_id, authority_domain, created_at, created_by.
--
-- `enterprise_id` is already permanent once set (object_enterprise_id_permanent). Not fixed, on
-- purpose: `lifecycle_state` (supersession is the declared way out of `accepted`, and the
-- transition guard owns it), `row_version`/`updated_at`/`updated_by` (bookkeeping every act
-- moves), `classification` and `retention_class` (governance of a closed record continues: it
-- is reclassified and its retention runs).
--
-- CLOSED means a state the ontology declares terminal (`registry.object_state.is_terminal`), and
-- additionally `decision_record` in `accepted`: KF-DEC-001 names accepted and rejected decisions
-- immutable, and `accepted` is not terminal only because supersession leads out of it
-- (R01-DEFECT-003 in ontology/state-machines.yaml). `rejected` is terminal already.
--
-- NO ACTION IS EXEMPT. The ontology declares no action that may rename or re-home a closed
-- record: `correct_record` is refused on accepted and rejected decisions by KF-DEC-001's own
-- precondition, and has no transition out of any terminal state. If one is ever declared, it is
-- added here by name, with the rule that permits it.

create function core.object_state_is_closed(p_object_type text, p_state text) returns boolean
language sql
stable
set search_path = pg_catalog, registry
as $$
  select coalesce(
           (select s.is_terminal
              from registry.object_state s
             where s.object_type = p_object_type and s.state = p_state),
           false)
      or (p_object_type = 'decision_record' and p_state = 'accepted')
$$;

comment on function core.object_state_is_closed(text, text) is
  'A terminal state, or an accepted decision (KF-DEC-001). A record in one keeps its title, type, '
  'organization, authority domain and creation facts: object_guard_4_closed_identity.';

create function core.enforce_closed_identity() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
declare
  v_changed text[] := array[]::text[];
begin
  if not core.object_state_is_closed(old.object_type, old.lifecycle_state) then
    return new;
  end if;

  if new.title is distinct from old.title then v_changed := array_append(v_changed, 'title'); end if;
  if new.object_type is distinct from old.object_type then
    v_changed := array_append(v_changed, 'object_type');
  end if;
  if new.organization_id is distinct from old.organization_id then
    v_changed := array_append(v_changed, 'organization_id');
  end if;
  if new.authority_domain is distinct from old.authority_domain then
    v_changed := array_append(v_changed, 'authority_domain');
  end if;
  if new.created_at is distinct from old.created_at then
    v_changed := array_append(v_changed, 'created_at');
  end if;
  if new.created_by is distinct from old.created_by then
    v_changed := array_append(v_changed, 'created_by');
  end if;

  if cardinality(v_changed) > 0 then
    raise exception '% % is % and closed: % may not change',
      old.object_type, old.id, old.lifecycle_state, array_to_string(v_changed, ', ')
      using errcode = 'check_violation',
            hint = case when old.object_type = 'decision_record'
                        then 'KF-DEC-001: supersede it with a new decision record.'
                        else 'A closed record is corrected by a new record, not rewritten.' end;
  end if;
  return new;
end
$$;

revoke execute on function core.enforce_closed_identity() from public;

-- After object_guard_1_context (a missing actor is the clearer message), 2_transition and
-- 3_row_version; BEFORE triggers fire in name order.
create trigger object_guard_4_closed_identity
  before update on core.object
  for each row execute function core.enforce_closed_identity();

-- migrate:down

drop trigger if exists object_guard_4_closed_identity on core.object;
drop function if exists core.enforce_closed_identity();
drop function if exists core.object_state_is_closed(text, text);
