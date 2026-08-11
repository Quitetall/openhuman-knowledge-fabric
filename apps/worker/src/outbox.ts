/**
 * The outbox drain.
 *
 * An action commits its domain change and an outbox row in ONE transaction, so there is no
 * state where the change landed and the notification did not. Delivery is this worker's
 * problem, and it is allowed to be late — it is not allowed to be lossy, and it is not
 * allowed to be authoritative.
 *
 * Three properties, in the order they matter:
 *
 *   AT LEAST ONCE, never at most once. A row is marked delivered only after its side effect
 *   succeeded, in the same transaction, so a crash between the two re-delivers rather than
 *   skipping. Every handler must therefore be idempotent — `search.index_object` is, by
 *   construction.
 *
 *   ONE DRAIN AT A TIME. Two workers on the same outbox would both claim the same rows under
 *   READ COMMITTED and do the work twice. `for update skip locked` is what makes a second
 *   worker take different rows instead of the same ones.
 *
 *   NEVER AUTHORITATIVE. Everything this worker writes is derived and rebuildable. If the
 *   outbox were lost entirely, `search.rebuild()` would restore the index from the records —
 *   which is the property that lets delivery be late without being dangerous.
 */

import { withTransaction, type Pool, type Tx } from '@kf/database';

export interface DrainResult {
  readonly delivered: number;
  readonly failed: number;
  /** Topics seen but with no handler. Reported, never silently dropped. */
  readonly unhandled: readonly string[];
}

export type OutboxHandler = (tx: Tx, payload: Record<string, unknown>) => Promise<void>;

/**
 * Keep the search index current.
 *
 * Re-indexes every object the action touched. Idempotent by construction: `index_object`
 * upserts, so a redelivered row costs one write and changes nothing.
 */
const reindexTargets: OutboxHandler = async (tx, payload) => {
  const targets = payload['targets'];
  if (!Array.isArray(targets)) return;
  for (const id of targets) {
    if (typeof id !== 'string') continue;
    await tx.query('select search.index_object($1)', [id]);
  }
};

/**
 * Which topics do what.
 *
 * Every action emits `kf.<action_type>`, and every one of them should refresh the index for
 * whatever it touched — so this is a default rather than a list that has to be extended each
 * time an action is added. A list would go stale silently, and the symptom would be records
 * that cannot be found.
 */
export const OUTBOX_HANDLERS: Readonly<Record<string, OutboxHandler>> = {
  '*': reindexTargets,
};

const DEFAULT_BATCH = 100;

export async function drainOutbox(
  pool: Pool,
  options: {
    readonly handlers?: Readonly<Record<string, OutboxHandler>>;
    readonly batchSize?: number;
  } = {},
): Promise<DrainResult> {
  const handlers = options.handlers ?? OUTBOX_HANDLERS;
  const batch = Math.min(Math.max(1, options.batchSize ?? DEFAULT_BATCH), 1000);

  return withTransaction(pool, async (tx) => {
    const rows = await tx.query<{ id: string; topic: string; payload: Record<string, unknown> }>(
      `select id, topic, payload from core.outbox
        where delivered_at is null
        order by created_at
        limit $1
        -- SKIP LOCKED, so a second worker takes DIFFERENT rows rather than waiting for these
        -- or, worse, doing them again.
        for update skip locked`,
      [batch],
    );

    let delivered = 0;
    let failed = 0;
    const unhandled = new Set<string>();

    for (const row of rows) {
      const handler = handlers[row.topic] ?? handlers['*'];
      if (handler === undefined) {
        // Left undelivered on purpose. Marking it delivered would discard the notification
        // for a topic somebody has not written a handler for yet, and the loss would be
        // silent and permanent.
        unhandled.add(row.topic);
        continue;
      }
      try {
        await handler(tx, row.payload);
        // Marked delivered in the SAME transaction as the effect. A crash between the two
        // would otherwise either lose the work or repeat it depending on the order, and only
        // one of those is recoverable.
        await tx.query('update core.outbox set delivered_at = now() where id = $1', [row.id]);
        delivered += 1;
      } catch {
        // One bad row must not strand the batch behind it. Left undelivered, so the next
        // drain retries it — and if it keeps failing, it stays visible as a growing backlog
        // rather than disappearing.
        failed += 1;
      }
    }

    return { delivered, failed, unhandled: [...unhandled].sort() };
  });
}

/** How far behind delivery is. The number an operator actually watches. */
export async function outboxBacklog(
  pool: Pool,
): Promise<{ pending: number; oldestSeconds: number | null }> {
  return withTransaction(pool, async (tx) => {
    const row = await tx.one<{ pending: string; oldest: string | null }>(
      `select count(*)::text as pending,
              extract(epoch from (now() - min(created_at)))::text as oldest
         from core.outbox where delivered_at is null`,
    );
    return {
      pending: Number(row.pending),
      oldestSeconds: row.oldest === null ? null : Math.floor(Number(row.oldest)),
    };
  });
}
