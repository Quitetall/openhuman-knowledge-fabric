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
  readonly failures: readonly {
    readonly id: string;
    readonly topic: string;
    readonly error: string;
  }[];
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

/** Record link delivery without ever moving token material into the worker or object store. */
const recordMasterRecordLinkDelivery: OutboxHandler = async (tx, payload) => {
  const linkId = payload['link_id'];
  const actionId = payload['action_id'];
  const payloadDigest = payload['payload_digest'];
  if (
    typeof linkId !== 'string' ||
    typeof actionId !== 'string' ||
    typeof payloadDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(payloadDigest)
  ) {
    throw new Error('master-record link delivery payload is malformed');
  }
  await tx.query('select content.record_master_record_link_delivery($1, $2, $3)', [
    linkId,
    actionId,
    payloadDigest,
  ]);
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
  'kf.master_record_link_issued': recordMasterRecordLinkDelivery,
};

const DEFAULT_BATCH = 100;

function boundedFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.length <= 1_024 ? message : `${message.slice(0, 1_021)}...`;
}

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
    const failures: { id: string; topic: string; error: string }[] = [];
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
      // A caught PostgreSQL error still leaves the transaction aborted. Isolate each row in
      // a savepoint so one handler can fail without making every later query fail with 25P02.
      // The effect and delivery mark remain atomic inside the enclosing transaction.
      await tx.query('savepoint kf_outbox_row');
      try {
        await handler(tx, row.payload);
        // Marked delivered in the SAME transaction as the effect. A crash between the two
        // would otherwise either lose the work or repeat it depending on the order, and only
        // one of those is recoverable.
        await tx.query('update core.outbox set delivered_at = now() where id = $1', [row.id]);
        await tx.query('release savepoint kf_outbox_row');
        delivered += 1;
      } catch (error: unknown) {
        await tx.query('rollback to savepoint kf_outbox_row');
        await tx.query('release savepoint kf_outbox_row');
        // One bad row must not strand the batch behind it. Left undelivered, so the next
        // drain retries it — and if it keeps failing, it stays visible as a growing backlog
        // rather than disappearing.
        failed += 1;
        failures.push({ id: row.id, topic: row.topic, error: boundedFailure(error) });
      }
    }

    return { delivered, failed, failures, unhandled: [...unhandled].sort() };
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
