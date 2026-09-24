/**
 * An object's history: every audit event about it, in ledger order.
 *
 * An event is about an object when it names it (`core.audit_event.object_id`) or when the act it
 * records targeted it (`core.action.target_ids`) — a multi-target act writes one event, naming at
 * most one of its targets.
 *
 * The query is index-driven on both legs, and that is the point of it living here once. It read
 * `e.object_id = $1 or $1 = any(select unnest(a.target_ids) from core.action a where a.id =
 * e.action_id)`, which PostgreSQL can only answer by walking EVERY audit event and running the
 * subquery per row: one object's history cost O(ledger), on every object view and every
 * `/objects/:id/history`. Now each leg is a lookup — `audit_by_object (object_id, seq)` for the
 * first; for the second, `core.actions_targeting` (20260925142200) reads the GIN index
 * `action_by_target`, which the application's own `target_ids @> ...` could not use under row
 * security (the operator is not leakproof), then `audit_by_action (action_id)`. The union removes
 * an event both legs find. `tests/database/history-plan.test.ts` holds the buffers read flat while
 * unrelated ledger rows grow tenfold.
 *
 * `$1` is the object id. Columns are the history an object view shows; callers map what they
 * need.
 */
export const OBJECT_HISTORY_SQL = `
  select e.seq, e.action_type, e.actor_id, e.acting_role_id, e.recorded_at, e.effective_at,
         e.reason, e.digest
    from core.audit_event e
   where e.object_id = $1::uuid
  union
  select e.seq, e.action_type, e.actor_id, e.acting_role_id, e.recorded_at, e.effective_at,
         e.reason, e.digest
    from core.actions_targeting($1::uuid) targeting (action_id)
    join core.audit_event e on e.action_id = targeting.action_id
   order by seq`;

/** One row of `OBJECT_HISTORY_SQL`, as the driver returns it. */
export type ObjectHistoryRow = {
  readonly seq: string;
  readonly action_type: string;
  readonly actor_id: string;
  readonly acting_role_id: string;
  readonly recorded_at: Date;
  readonly effective_at: Date;
  readonly reason: string | null;
  readonly digest: string;
};
