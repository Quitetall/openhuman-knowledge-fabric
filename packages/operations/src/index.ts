/**
 * Operational readiness.
 *
 * One function that answers "is this system in the state it is supposed to be in", and fails
 * closed on every question it cannot answer. A check that cannot run reports `unknown`, and
 * `unknown` counts as failure — because the alternative is a dashboard that turns green when
 * monitoring breaks, which is precisely when it should not.
 *
 * Every check names what it would mean if it failed. A red light with no consequence attached
 * gets acknowledged and ignored; the second time, faster.
 */

import { withTransaction, type Pool, type Tx } from '@kf/database';

export type CheckStatus = 'ok' | 'degraded' | 'failed' | 'unknown';

export interface Check {
  readonly id: string;
  readonly status: CheckStatus;
  /** What it means that this check is in this state. */
  readonly detail: string;
  readonly measured?: Readonly<Record<string, number | string | null>>;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: readonly Check[];
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

const DEFAULTS: Required<ReadinessThresholds> = {
  outboxPending: 1000,
  outboxAgeSeconds: 900,
  uncheckpointedEvents: 5000,
  federationStaleDays: 30,
};

type CheckFn = (tx: Tx, limits: Required<ReadinessThresholds>) => Promise<Check>;

/**
 * The audit chain is intact from genesis.
 *
 * Not a sample — every event, in order. On a large log this is the slowest check here, and it
 * is also the only one whose failure means the record itself is untrustworthy, so it is not
 * the one to make cheap.
 */
const chainIntact: CheckFn = async (tx) => {
  const row = await tx.one<{ breaks: string; total: string }>(
    `with linked as (
       select seq, prev_digest,
              lag(digest) over (order by seq) as expected_prev
         from core.audit_event
     )
     select count(*) filter (
              where (expected_prev is null and prev_digest <> repeat('0', 64))
                 or (expected_prev is not null and prev_digest <> expected_prev)
            )::text as breaks,
            count(*)::text as total
       from linked`,
  );
  const breaks = Number(row.breaks);
  return {
    id: 'audit_chain',
    status: breaks === 0 ? 'ok' : 'failed',
    detail:
      breaks === 0
        ? 'Every audit event links to its predecessor.'
        : `${breaks} audit event(s) do not link. The record has been altered, or a write bypassed the dispatcher.`,
    measured: { events: Number(row.total), breaks },
  };
};

/**
 * History is covered by signed checkpoints.
 *
 * Degraded rather than failed while a tail sits uncheckpointed: that is normal between runs.
 * It becomes failure when the tail is large enough that a rewrite of it would go undetected
 * for longer than anybody would accept.
 */
const checkpointCoverage: CheckFn = async (tx, limits) => {
  const row = await tx.one<{ uncovered: string; checkpoints: string; last_at: Date | null }>(
    `select (select count(*) from core.audit_event e
              where not exists (
                select 1 from core.audit_checkpoint c
                 where e.seq between c.from_seq and c.to_seq))::text as uncovered,
            (select count(*) from core.audit_checkpoint)::text as checkpoints,
            (select max(recorded_at) from core.audit_checkpoint) as last_at`,
  );
  const uncovered = Number(row.uncovered);
  const checkpoints = Number(row.checkpoints);

  if (checkpoints === 0) {
    return {
      id: 'checkpoint_coverage',
      status: 'failed',
      detail:
        'No audit checkpoint has ever been signed. A rewrite of the whole log would be undetectable to anyone without an older copy.',
      measured: { checkpoints: 0, uncovered },
    };
  }
  return {
    id: 'checkpoint_coverage',
    status:
      uncovered === 0 ? 'ok' : uncovered <= limits.uncheckpointedEvents ? 'degraded' : 'failed',
    detail:
      uncovered === 0
        ? 'Every audit event sits inside a signed checkpoint.'
        : `${uncovered} audit event(s) are outside any signed checkpoint; a rewrite of them would not be detectable by signature.`,
    measured: {
      uncovered,
      checkpoints,
      lastSignedAt: row.last_at === null ? null : row.last_at.toISOString(),
    },
  };
};

/** Delivery is keeping up. Reports an age as well as a count. */
const outboxHealth: CheckFn = async (tx, limits) => {
  const row = await tx.one<{ pending: string; oldest: string | null }>(
    `select count(*)::text as pending,
            extract(epoch from (now() - min(created_at)))::text as oldest
       from core.outbox where delivered_at is null`,
  );
  const pending = Number(row.pending);
  const age = row.oldest === null ? 0 : Math.floor(Number(row.oldest));

  const behind = pending > limits.outboxPending || age > limits.outboxAgeSeconds;
  return {
    id: 'outbox_delivery',
    status: pending === 0 ? 'ok' : behind ? 'degraded' : 'ok',
    // Degraded, never failed: nothing the outbox delivers is authoritative, so being behind
    // costs freshness rather than correctness. Saying so stops it being treated as an outage.
    detail: behind
      ? `Delivery is behind: ${pending} pending, oldest ${age}s. Derived indexes are stale; no record is wrong.`
      : 'Delivery is current.',
    measured: { pending, oldestSeconds: age },
  };
};

/** Every record is findable. A partial index looks complete and is not. */
const searchComplete: CheckFn = async (tx) => {
  const row = await tx.one<{ objects: string; indexed: string }>(
    `select (select count(*) from core.object)::text as objects,
            (select count(*) from search.document)::text as indexed`,
  );
  const objects = Number(row.objects);
  const indexed = Number(row.indexed);
  return {
    id: 'search_index',
    status: indexed >= objects ? 'ok' : 'degraded',
    detail:
      indexed >= objects
        ? 'Every record is indexed.'
        : `${objects - indexed} record(s) are not indexed and cannot be found by search. Run search.rebuild().`,
    measured: { objects, indexed },
  };
};

/** Citations of other systems have been re-checked recently. */
const federationFreshness: CheckFn = async (tx, limits) => {
  const row = await tx.one<{ total: string; stale: string; never: string }>(
    `select count(*)::text as total,
            count(*) filter (where verified_at < now() - make_interval(days => $1))::text as stale,
            count(*) filter (where verified_at is null)::text as never
       from quality.federated_reference`,
    [limits.federationStaleDays],
  );
  const total = Number(row.total);
  const stale = Number(row.stale) + Number(row.never);
  if (total === 0) {
    return {
      id: 'federation_freshness',
      status: 'ok',
      detail: 'No federated references are recorded.',
      measured: { total: 0, stale: 0 },
    };
  }
  return {
    id: 'federation_freshness',
    status: stale === 0 ? 'ok' : 'degraded',
    detail:
      stale === 0
        ? 'Every federated reference has been re-verified recently.'
        : `${stale} federated reference(s) have not been re-verified in ${limits.federationStaleDays} days. Drift in another system would not yet have been noticed.`,
    measured: { total, stale },
  };
};

/**
 * The schema is the one the application expects.
 *
 * A registry with no current release means the ontology seed never ran, and every record
 * written afterwards would carry a schema version nothing can resolve.
 */
const schemaRelease: CheckFn = async (tx) => {
  const row = await tx.maybeOne<{ version: string; ontology_digest: string }>(
    'select version, ontology_digest from registry.schema_release where is_current',
  );
  if (row === undefined) {
    return {
      id: 'schema_release',
      status: 'failed',
      detail: 'No current schema release. The ontology seed has not been applied.',
    };
  }
  return {
    id: 'schema_release',
    status: 'ok',
    detail: `Schema release ${row.version} is current.`,
    measured: { version: row.version, ontologyDigest: row.ontology_digest.slice(0, 12) },
  };
};

/** Records exist that nothing can ever change again, because their type has no live actions. */
const writeGuardsPresent: CheckFn = async (tx) => {
  const row = await tx.one<{ guards: string }>(
    `select count(*)::text as guards from pg_trigger
      where tgname in ('object_guard_1_context', 'object_guard_2_transition',
                       'object_guard_3_row_version')
        and not tgisinternal`,
  );
  const guards = Number(row.guards);
  return {
    id: 'write_guards',
    status: guards === 3 ? 'ok' : 'failed',
    // Dropping a trigger is DDL and shows in the log — but only if somebody reads the log.
    // This is the check that notices.
    detail:
      guards === 3
        ? 'All three write guards are installed.'
        : `Only ${guards} of 3 write guards are installed. Controlled records can be changed without an action.`,
    measured: { guards },
  };
};

const CHECKS: readonly CheckFn[] = [
  schemaRelease,
  writeGuardsPresent,
  chainIntact,
  checkpointCoverage,
  outboxHealth,
  searchComplete,
  federationFreshness,
];

/**
 * Run every check.
 *
 * A check that throws becomes `unknown`, and `unknown` is not ready. The failure mode this
 * prevents is the important one: a monitoring path that breaks and reports health because
 * nothing came back to contradict it.
 */
export async function assessReadiness(
  pool: Pool,
  thresholds: ReadinessThresholds = {},
): Promise<ReadinessReport> {
  const limits = { ...DEFAULTS, ...thresholds };

  const checks = await withTransaction(pool, async (tx) => {
    const results: Check[] = [];
    for (const check of CHECKS) {
      try {
        results.push(await check(tx, limits));
      } catch (err: unknown) {
        results.push({
          id: 'unknown',
          status: 'unknown',
          detail: `A readiness check could not run: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return results;
  });

  return {
    // Degraded is not ready either. "Ready" is a claim about being in the intended state, and
    // a stale index or a lagging outbox is not that — it is a working system with a known
    // shortfall, which is worth distinguishing in the detail rather than in the verdict.
    ready: checks.every((c) => c.status === 'ok'),
    checks,
  };
}

/** One line per check, for a terminal or a log. */
export function formatReadiness(report: ReadinessReport): string {
  const mark: Record<CheckStatus, string> = {
    ok: 'ok      ',
    degraded: 'degraded',
    failed: 'FAILED  ',
    unknown: 'UNKNOWN ',
  };
  const lines = report.checks.map((c) => `  ${mark[c.status]}  ${c.id}\n            ${c.detail}`);
  return [report.ready ? 'READY' : 'NOT READY', ...lines].join('\n');
}

export const PACKAGE = {
  name: '@kf/operations',
  role: 'Operational readiness, fail-closed',
  owns: [],
} as const;
