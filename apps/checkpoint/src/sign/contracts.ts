import type { KeyObject } from 'node:crypto';

export type AuditSequence = string;
export type LegacyCheckpointFormat = 'kf.audit-checkpoint.v1' | 'kf.audit-checkpoint.v2';
export type CheckpointFormat = LegacyCheckpointFormat | 'kf.audit-checkpoint.v3';

/** One complete audit event plus action target identities needed to recompute its chain link. */
export interface AuditEntry {
  /** Canonical positive PostgreSQL bigint decimal. Never a JavaScript number. */
  readonly seq: AuditSequence;
  readonly id: string;
  readonly action_id: string;
  readonly actor_id: string;
  readonly acting_role_id: string;
  readonly action_type: string;
  readonly object_id: string | null;
  readonly object_ids: readonly string[];
  readonly recorded_at: string;
  readonly effective_at: string;
  readonly request_id: string | null;
  readonly reason: string | null;
  readonly before_digest: string | null;
  readonly after_digest: string | null;
  readonly prev_digest: string;
  readonly digest: string;
}

interface CheckpointCommon {
  readonly merkleRoot: string;
  readonly signature: string;
  readonly signingKeyId: string;
}

/** Historical numeric JSON/JCS contract. Verification remains supported; new emission does not. */
export interface LegacyCheckpoint extends CheckpointCommon {
  readonly formatVersion: LegacyCheckpointFormat;
  /** JSON numbers were emitted historically; database verification may supply exact text. */
  readonly fromSeq: number | string;
  readonly toSeq: number | string;
  readonly leafCount: number | string;
}

/** Exact v3 wire contract. PostgreSQL bigint values are canonical decimal strings. */
export interface ExactCheckpoint extends CheckpointCommon {
  readonly formatVersion: 'kf.audit-checkpoint.v3';
  readonly fromSeq: AuditSequence;
  readonly toSeq: AuditSequence;
  readonly leafCount: string;
}

export type Checkpoint = LegacyCheckpoint | ExactCheckpoint;

export interface SigningKey {
  readonly id: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}
