import type { CheckFn } from './contracts.js';

export const outboxHealth: CheckFn = async (tx, limits) => {
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
    detail: behind
      ? `Delivery is behind: ${pending} pending, oldest ${age}s. Derived indexes are stale; no record is wrong.`
      : 'Delivery is current.',
    measured: { pending, oldestSeconds: age },
  };
};

export const searchComplete: CheckFn = async (tx) => {
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

export const federationFreshness: CheckFn = async (tx, limits) => {
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
