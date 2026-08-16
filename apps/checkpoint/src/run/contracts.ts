import type { KeyObject } from 'node:crypto';

import type { AuditEntry, AuditSequence, CheckpointFormat, ExactCheckpoint } from '../sign.js';

/** Rows the checkpoint reads. Deliberately the same shape the export writes. */
export interface RawEvent extends Record<string, unknown> {
  seq: string;
  id: string;
  action_id: string;
  actor_id: string;
  acting_role_id: string;
  action_type: string;
  object_id: string | null;
  object_ids: string[];
  recorded_at: Date;
  effective_at: Date;
  request_id: string | null;
  reason: string | null;
  before_digest: string | null;
  after_digest: string | null;
  prev_digest: string;
  digest: string;
}

export interface PositionedEvent {
  readonly entry: AuditEntry;
  readonly seq: bigint;
}

export type StoredCheckpoint = ExactCheckpoint & {
  readonly id: string;
  readonly storageUri: string | null;
};

export interface RunResult {
  readonly status: 'signed' | 'nothing_pending';
  readonly checkpoint?: StoredCheckpoint;
  readonly eventCount: number;
}

export interface CheckpointRow extends Record<string, unknown> {
  readonly id: string;
  readonly from_seq: string;
  readonly to_seq: string;
  readonly leaf_count: string;
  readonly merkle_root: string;
  readonly signature: string;
  readonly signing_key_id: string;
  readonly format_version: CheckpointFormat;
}

export interface LedgerFinding {
  readonly kind:
    | 'chain_broken'
    | 'root_mismatch'
    | 'bad_signature'
    | 'unknown_key'
    | 'gap'
    | 'overlap'
    | 'missing_events'
    | 'unsupported_legacy_range';
  readonly detail: string;
  readonly atSeq?: AuditSequence;
}

export type VerificationKeys = ReadonlyMap<string, KeyObject>;
