/**
 * Advisory lock key for the checkpoint run. An arbitrary constant — advisory locks carry no
 * meaning beyond agreement between the processes that take them.
 */
export const CHECKPOINT_LOCK = 0x6b665f6370;
export const JS_SAFE_INTEGER_MAX = 9_007_199_254_740_991n;

export const EVENT_COLUMNS = `event.seq, event.id, event.action_id, event.actor_id,
                       event.acting_role_id, event.action_type, event.object_id,
                       action.target_ids as object_ids, event.recorded_at, event.effective_at,
                       event.request_id, event.reason, event.before_digest, event.after_digest,
                       event.prev_digest, event.digest`;
export const EVENT_SOURCE = `core.audit_event event
                      join core.action action on action.id = event.action_id`;
