-- migrate:up

-- The acts that targeted an object, found by index (OBJECT_HISTORY_SQL in @kf/actions).
--
-- An object's history is every audit event naming it, plus every event of an act that targeted
-- it. The second leg used to be a per-event subquery on core.action.target_ids, so reading one
-- object's history walked the whole ledger. `action_by_target` (GIN on target_ids, 20260811000300)
-- exists for exactly this lookup, and the application still cannot use it: `@>` on arrays is not
-- leakproof, so under core.action's row security PostgreSQL will not evaluate it ahead of the
-- policy and falls back to a sequential scan of every act (measured:
-- tests/database/history-plan.test.ts).
--
-- This seam answers the lookup as the owner, which bypasses row security, and applies the
-- policy's own predicate itself — the caller's organization, from the sealed context — so it
-- returns exactly the act ids core.action's read policy would have let the caller see. It returns
-- ids only; the audit events they lead to are still read under the caller's row security.

-- And the index answers in a bounded number of pages. With GIN's default fast update, new entries
-- queue in an unordered pending list that EVERY lookup scans until a vacuum merges it — up to
-- gin_pending_list_limit (4MB) of recent acts per history read on a busy ledger, which is the
-- O(ledger) cost again under another name (measured: the lookup's buffers grew with unrelated
-- acts until the list was merged). One entry per target per act is cheap to merge at insert, so
-- the ledger pays that instead of every reader.
alter index core.action_by_target set (fastupdate = off);
select gin_clean_pending_list('core.action_by_target'::regclass);

create function core.actions_targeting(p_object uuid) returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog
rows 8
as $$
  select a.id
    from core.action a
   where a.target_ids @> array[p_object]
     and a.organization_id = (select core.current_organization())
$$;

comment on function core.actions_targeting(uuid) is
  'The acts in the caller''s organization that targeted an object, by the GIN index '
  'action_by_target. Ids only; row security still governs the audit events they lead to.';

revoke all on function core.actions_targeting(uuid) from public;
grant execute on function core.actions_targeting(uuid) to kf_app, kf_worker, kf_readonly;

-- migrate:down

drop function core.actions_targeting(uuid);
alter index core.action_by_target reset (fastupdate);
