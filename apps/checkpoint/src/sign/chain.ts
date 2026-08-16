import { auditChainDigest, canonicalize } from '@kf/canonicalization';

import type { AuditEntry, AuditSequence, CheckpointFormat } from './contracts.js';
import { auditSequence, isCheckpointFormat, legacyWireNumber } from './sequences.js';

export function assertStrictlyIncreasingSequences(entries: readonly AuditEntry[]): void {
  let previous = 0n;
  for (const entry of entries) {
    const current = BigInt(auditSequence(entry.seq));
    if (current <= previous) {
      throw new RangeError('checkpoint audit sequences must be strictly increasing');
    }
    previous = current;
  }
}

/**
 * The bytes a leaf commits to.
 *
 * The event's own `digest` alone would be enough to detect a changed event, but not a
 * REORDERED or REPLACED one — two events could swap sequence numbers and every digest would
 * still verify. Including `seq` binds each event to its position.
 */
export function leafBytes(entry: AuditEntry, formatVersion: CheckpointFormat): Buffer {
  if (!isCheckpointFormat(formatVersion)) {
    throw new Error(`unknown checkpoint format: ${String(formatVersion)}`);
  }
  const seq =
    formatVersion === 'kf.audit-checkpoint.v3'
      ? auditSequence(entry.seq)
      : legacyWireNumber(entry.seq);
  const value =
    formatVersion === 'kf.audit-checkpoint.v1'
      ? {
          seq,
          id: entry.id,
          action_id: entry.action_id,
          actor_id: entry.actor_id,
          action_type: entry.action_type,
          recorded_at: entry.recorded_at,
          prev_digest: entry.prev_digest,
          digest: entry.digest,
        }
      : {
          seq,
          id: entry.id,
          action_id: entry.action_id,
          actor_id: entry.actor_id,
          acting_role_id: entry.acting_role_id,
          action_type: entry.action_type,
          object_id: entry.object_id,
          object_ids: [...entry.object_ids],
          recorded_at: entry.recorded_at,
          effective_at: entry.effective_at,
          request_id: entry.request_id,
          reason: entry.reason,
          before_digest: entry.before_digest,
          after_digest: entry.after_digest,
          prev_digest: entry.prev_digest,
          digest: entry.digest,
        };
  return Buffer.from(canonicalize(value), 'utf8');
}

/**
 * Walk the chain and report the first place it breaks.
 *
 * Run before signing: a checkpoint over a broken chain would attest to tampering rather
 * than against it.
 */
export function verifyChain(
  entries: readonly AuditEntry[],
  expectedFirstPrev: string,
): { ok: true } | { ok: false; atSeq: AuditSequence; detail: string } {
  let prev = expectedFirstPrev;
  for (const e of entries) {
    if (e.prev_digest !== prev) {
      return {
        ok: false,
        atSeq: e.seq,
        detail: `prev_digest is ${e.prev_digest}, expected ${prev}`,
      };
    }
    const recomputed = auditChainDigest(prev, {
      action_id: e.action_id,
      action_type: e.action_type,
      actor_id: e.actor_id,
      acting_role_id: e.acting_role_id,
      object_ids: e.object_ids,
      effective_at: e.effective_at,
      before_digest: e.before_digest,
      after_digest: e.after_digest,
    });
    if (e.digest !== recomputed) {
      return {
        ok: false,
        atSeq: e.seq,
        detail: `digest is ${e.digest}, recomputed ${recomputed}`,
      };
    }
    prev = e.digest;
  }
  return { ok: true };
}
