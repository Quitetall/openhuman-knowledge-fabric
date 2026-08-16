import type { Tx } from '@kf/database';

export type CheckStatus = 'ok' | 'degraded' | 'failed' | 'unknown';

export type ReadinessScope = 'service' | 'institutional';

export interface Check {
  readonly id: string;
  /** Which verdict this check can affect. */
  readonly scope: ReadinessScope;
  readonly status: CheckStatus;
  /** What it means that this check is in this state. */
  readonly detail: string;
  readonly measured?: Readonly<Record<string, number | string | null>>;
}

export interface ReadinessPartition {
  readonly ready: boolean;
  readonly checks: readonly Check[];
}

export interface ReadinessReport {
  /** Backward-compatible alias for `service.ready`. */
  readonly ready: boolean;
  /** Backward-compatible alias for `service.checks`. */
  readonly checks: readonly Check[];
  readonly service: ReadinessPartition;
  readonly institutional: ReadinessPartition;
}

export interface ReadinessThresholds {
  /** Undelivered outbox rows above which delivery is considered behind. */
  readonly outboxPending?: number;
  /** Age in seconds of the oldest undelivered row before it is a problem. */
  readonly outboxAgeSeconds?: number;
  /** Audit events allowed to sit outside any signed checkpoint. */
  readonly uncheckpointedEvents?: number;
  /** Days after which a federated reference is considered unverified. */
  readonly federationStaleDays?: number;
}

export const DEFAULTS: Required<ReadinessThresholds> = {
  outboxPending: 1000,
  outboxAgeSeconds: 900,
  uncheckpointedEvents: 5000,
  federationStaleDays: 30,
};

export type CheckResult = Omit<Check, 'scope'>;

export type CheckFn = (tx: Tx, limits: Required<ReadinessThresholds>) => Promise<CheckResult>;

export interface CheckDefinition {
  readonly id: string;
  readonly scope: ReadinessScope;
  readonly run: CheckFn;
}

export interface RecoveryObjective {
  readonly [key: string]: unknown;
  readonly rpo_seconds: number;
  readonly rto_seconds: number | null;
  readonly restore_drill_days: number;
  readonly requires_pitr: boolean;
  readonly declared_at: Date;
}
