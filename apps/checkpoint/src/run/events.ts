import { auditSequence, type AuditEntry } from '../sign.js';
import type { PositionedEvent, RawEvent } from './contracts.js';

/** First event whose sequence is >= target. Input is ordered by PostgreSQL. */
export function lowerBound(events: readonly PositionedEvent[], target: bigint): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (events[middle]!.seq < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** First event whose sequence is > target. */
export function upperBound(events: readonly PositionedEvent[], target: bigint): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (events[middle]!.seq <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function toEntry(r: RawEvent): AuditEntry {
  return {
    // Keep PostgreSQL bigint exact. v3 hashes this canonical decimal string directly.
    seq: auditSequence(r.seq),
    id: r.id,
    action_id: r.action_id,
    actor_id: r.actor_id,
    acting_role_id: r.acting_role_id,
    action_type: r.action_type,
    object_id: r.object_id,
    object_ids: r.object_ids,
    recorded_at: r.recorded_at.toISOString(),
    effective_at: r.effective_at.toISOString(),
    request_id: r.request_id,
    reason: r.reason,
    before_digest: r.before_digest,
    after_digest: r.after_digest,
    prev_digest: r.prev_digest,
    digest: r.digest,
  };
}
