/**
 * Embed on ingest (§64A, KF-SAS-RQ-218, RQ-225), and the pump that does it in bounded time
 * (SAS §100.44, KF-SAS-RQ-201).
 *
 * After an act commits, its outbox row names the objects it touched. The drain re-indexes them for
 * lexical search and, when a retrieval engine is configured, queues them in `retrieval.embed_pending`
 * in the SAME transaction that marks the row delivered — so a record is never indexed and silently
 * never embedded.
 *
 * The engine is reached from a separate pump, never from inside the drain, and never with a
 * transaction open. The pump keeps up to N engine requests in flight (`concurrency`): each of N
 * consumers claims ONE record (a short transaction, committed), hands its text to the engine's
 * vectors-only write (no transaction), and completes it (another short transaction), then claims
 * the next, until nothing is claimable. The engine may be slow or down; the database does not wait
 * for it.
 *
 * Why one record per claim, not a batch. A claim is a lease, and a lease must outlive the work it
 * covers or another worker claims the record and embeds it a second time. A batch claimed up
 * front is worked through behind the other consumers, so its last record's lease runs while the
 * records ahead of it are embedded; one record per claim makes the lease cover exactly one engine
 * request, which the client's timeout bounds. `drainEmbeddings` refuses a lease shorter than twice
 * that timeout.
 *
 * Why the pump drains to empty. Until 20261007500000 the pump claimed one batch of 32 per
 * two-second tick, so however fast the engine was the queue moved at most 960 records a minute
 * (measured about 900, SAS §100.44). It now runs until nothing is claimable and only then sleeps.
 *
 * Failures. A record the engine refused, or that could not be completed, is counted against it in
 * the database (`retrieval.fail_embedding`): it waits base · 2^(attempts−1) seconds before it may be
 * claimed again, and after `maxAttempts` the pump gives up and the row RECORDS it — when, how many
 * attempts, which class of failure — and is not claimed again until the record is enqueued again.
 * An engine that fails several records in a row is a failing engine rather than failing records:
 * the pass stops (`stoppedBy: 'failing'`) and the pump backs off as a whole, doubling its wait to
 * five minutes. An engine that does not answer the handshake is asked before anything is claimed,
 * so an outage takes no claim and costs no record an attempt.
 *
 * And the text goes only to a path that keeps none of it: the client refuses, before writing the
 * text, any engine whose handshake does not declare `vectors_only_write` from a local, pinned
 * embedder. The worker checks the same thing at startup and refuses to start without it, and each
 * pass checks it again before claiming anything.
 */

import { withTransaction, type Pool } from '@kf/database';
import { VECTORS_ONLY_WRITE, type RetrievalClient } from '@kf/retrieval';
import { OUTBOX_HANDLERS, type OutboxHandler } from './outbox.js';

/**
 * The default outbox handler, plus the embedding queue. Idempotent like the handler it wraps: an
 * object queued twice is queued once. Queued again while it is being embedded, it is embedded
 * again after that embedding ends, never beside it (20261007500000).
 */
export const embeddingOutboxHandler: OutboxHandler = async (tx, payload) => {
  await OUTBOX_HANDLERS['*']!(tx, payload);
  const targets = Array.isArray(payload['targets'])
    ? payload['targets'].filter((id): id is string => typeof id === 'string')
    : [];
  if (targets.length === 0) return;
  await tx.query('select retrieval.enqueue_embedding($1::uuid[])', [targets]);
};

/**
 * Refuse to start against an engine that could persist record text or embed it off-host.
 *
 * Throws with the engine's reason; a composition root lets that end the process.
 */
export async function requireVectorsOnlyEngine(client: RetrievalClient): Promise<void> {
  const probe = await client.probe(VECTORS_ONLY_WRITE);
  if ('status' in probe) {
    throw new Error(`retrieval engine refused at startup: ${probe.reason}`);
  }
}

/** The classes a failure is recorded under. Never the engine's words, which could quote text. */
export type EmbeddingFailure = 'engine_refused' | 'engine_unavailable' | 'completion_failed';

/** What became of one failed attempt (`retrieval.fail_embedding`). */
export type FailureOutcome = 'retry' | 'recorded' | 'requeued' | 'superseded';

export interface EmbeddingDrainResult {
  readonly claimed: number;
  readonly embedded: number;
  /**
   * Why the pass ended: nothing was claimable (`empty`), the engine failed the handshake before
   * anything was claimed (`engine_unavailable`), it failed `failureLimit` records in a row
   * (`failing`), or the caller asked it to stop (`stopped`).
   */
  readonly stoppedBy: 'empty' | 'engine_unavailable' | 'failing' | 'stopped';
  /**
   * Failed attempts this pass, in the order they happened: `retry` is backing off, `recorded` was
   * given up on and recorded so, `requeued` failed on text that had since changed (not counted).
   */
  readonly failed: readonly {
    readonly objectId: string;
    readonly failure: EmbeddingFailure;
    readonly outcome: FailureOutcome;
  }[];
  /** The engine's reason when it failed the handshake. */
  readonly reason?: string;
}

export interface EmbeddingOptions {
  /** Engine requests in flight at once, 1 to MAX_EMBEDDING_CONCURRENCY. */
  readonly concurrency?: number;
  /** How long a claim holds its record, in seconds: at least twice `engineTimeoutMs`. */
  readonly leaseSeconds?: number;
  /** The client's timeout, which bounds one engine request. */
  readonly engineTimeoutMs?: number;
  /** The first retry's wait, in seconds; each later one doubles, to an hour. */
  readonly backoffBaseSeconds?: number;
  /** Attempts before the pump gives up on a record and records that it did. */
  readonly maxAttempts?: number;
  /** Consecutive failures that mean the engine, not the records, is failing. */
  readonly failureLimit?: number;
  /** Checked before each claim; true ends the pass. */
  readonly shouldStop?: () => boolean;
}

/**
 * Engine requests in flight by default: one, sized for the host this ships to — one CPU embedder
 * on a four-vCPU machine — where more did not go faster. Measured on Véracier records
 * (docs/agents/in-app-agent.md, "The embedding pump"): bge-m3 on four CPU cores embedded 13
 * records a minute at one in flight and 10 to 11 at two or four, where a long record also outran
 * the engine timeout and was embedded again; on the GPU fixture, four in flight beat one by a
 * fifth and eight added nothing. KF_EMBEDDING_CONCURRENCY raises it where the embedder can take
 * more (the fixture stack sets 4).
 */
export const DEFAULT_EMBEDDING_CONCURRENCY = 1;
export const MAX_EMBEDDING_CONCURRENCY = 16;
/** The worker's engine timeout: one long record embedded on a CPU takes seconds, not two. */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 60_000;
export const DEFAULT_EMBEDDING_LEASE_SECONDS = 300;
export const DEFAULT_BACKOFF_BASE_SECONDS = 15;
export const DEFAULT_MAX_ATTEMPTS = 8;

/** The class of a failed write, from the client's outcome. */
export function failureOf(reason: string): EmbeddingFailure {
  // `RetrievalClient.writeVector` answers `engine refused: <code> — <detail>` when the engine
  // answered with an error, and other reasons when it never answered usably.
  return reason.startsWith('engine refused:') ? 'engine_refused' : 'engine_unavailable';
}

function integerIn(name: string, value: number, low: number, high: number): number {
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new RangeError(`embedding ${name} must be an integer from ${low} to ${high}`);
  }
  return value;
}

type ClaimedRow = {
  readonly object_id: string;
  readonly organization_id: string;
  readonly text: string | null;
  readonly claim: string;
};

/**
 * One pass of the embedding pump: keep up to `concurrency` engine requests in flight until nothing
 * is claimable, the engine fails, or `shouldStop` says so.
 */
export async function drainEmbeddings(
  pool: Pool,
  client: RetrievalClient,
  options: EmbeddingOptions = {},
): Promise<EmbeddingDrainResult> {
  const concurrency = integerIn(
    'concurrency',
    options.concurrency ?? DEFAULT_EMBEDDING_CONCURRENCY,
    1,
    MAX_EMBEDDING_CONCURRENCY,
  );
  const leaseSeconds = integerIn(
    'lease',
    options.leaseSeconds ?? DEFAULT_EMBEDDING_LEASE_SECONDS,
    1,
    3600,
  );
  const engineTimeoutMs = options.engineTimeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
  if (!(engineTimeoutMs > 0) || leaseSeconds * 1000 < 2 * engineTimeoutMs) {
    // A lease that can lapse while its holder still waits on the engine lets a second worker
    // claim the record and embed it again.
    throw new RangeError(
      `embedding lease (${String(leaseSeconds)}s) must be at least twice the engine timeout ` +
        `(${String(engineTimeoutMs)}ms)`,
    );
  }
  const backoffBase = integerIn(
    'backoff base',
    options.backoffBaseSeconds ?? DEFAULT_BACKOFF_BASE_SECONDS,
    1,
    3600,
  );
  const maxAttempts = integerIn('attempts', options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 100);
  const failureLimit = integerIn('failure limit', options.failureLimit ?? 2 * concurrency, 1, 1000);

  // Before anything is claimed: an engine that cannot be reached costs no record an attempt.
  const probe = await client.probe(VECTORS_ONLY_WRITE);
  if ('status' in probe) {
    return {
      claimed: 0,
      embedded: 0,
      stoppedBy: 'engine_unavailable',
      failed: [],
      reason: probe.reason,
    };
  }

  let claimed = 0;
  let embedded = 0;
  let consecutiveFailures = 0;
  let ended: EmbeddingDrainResult['stoppedBy'] | undefined;
  const failed: EmbeddingDrainResult['failed'][number][] = [];

  const fail = async (row: ClaimedRow, failure: EmbeddingFailure): Promise<void> => {
    consecutiveFailures += 1;
    let outcome: FailureOutcome;
    try {
      const recorded = await withTransaction(pool, (tx) =>
        tx.one<{ outcome: FailureOutcome }>(
          'select retrieval.fail_embedding($1, $2, $3, $4, $5) as outcome',
          [row.object_id, row.claim, failure, backoffBase, maxAttempts],
        ),
      );
      outcome = recorded.outcome;
    } catch {
      // The failure could not be counted; the lease lapses and the record is claimed again.
      outcome = 'retry';
    }
    failed.push({ objectId: row.object_id, failure, outcome });
  };

  async function consume(): Promise<void> {
    for (;;) {
      if (ended !== undefined) return;
      if (options.shouldStop?.() === true) {
        ended = 'stopped';
        return;
      }
      if (consecutiveFailures >= failureLimit) {
        ended = 'failing';
        return;
      }
      const [row] = await withTransaction(pool, (tx) =>
        tx.query<ClaimedRow>(
          'select object_id, organization_id, text, claim from retrieval.claim_embeddings(1, $1)',
          [leaseSeconds],
        ),
      );
      // Nothing claimable for this consumer. The others finish what they hold.
      if (row === undefined) return;
      claimed += 1;
      // No transaction is open while the engine works.
      let outcome: Awaited<ReturnType<RetrievalClient['writeVector']>>;
      try {
        outcome = await client.writeVector({
          organizationId: row.organization_id,
          objectId: row.object_id,
          text: row.text ?? '',
        });
      } catch {
        // An arbitrary transport exception may contain text or credentials; never report it.
        await fail(row, 'engine_unavailable');
        continue;
      }
      if ('status' in outcome) {
        await fail(row, failureOf(outcome.reason));
        continue;
      }
      try {
        await withTransaction(pool, (tx) =>
          tx.query('select retrieval.complete_embedding($1, $2)', [row.object_id, row.claim]),
        );
      } catch {
        await fail(row, 'completion_failed');
        continue;
      }
      consecutiveFailures = 0;
      embedded += 1;
    }
  }
  // Every consumer is waited for, even when one throws (a claim the database refused): a pass
  // that returned while its siblings still worked would let the next pass start beside them, and
  // more than `concurrency` requests would be in flight.
  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      consume().catch((error: unknown) => {
        ended ??= 'failing';
        throw error;
      }),
    ),
  );
  const thrown = settled.find((outcome) => outcome.status === 'rejected');
  if (thrown !== undefined) throw thrown.reason;
  return { claimed, embedded, stoppedBy: ended ?? 'empty', failed };
}

/** The queue as counts, for the log. No identifier. */
export async function embeddingBacklog(pool: Pool): Promise<{
  readonly waiting: number;
  readonly claimed: number;
  readonly backingOff: number;
  readonly gaveUp: number;
}> {
  const row = await withTransaction(pool, (tx) =>
    tx.one<{ waiting: string; claimed: string; backing_off: string; gave_up: string }>(
      'select waiting, claimed, backing_off, gave_up from retrieval.embedding_backlog()',
    ),
  );
  return {
    waiting: Number(row.waiting),
    claimed: Number(row.claimed),
    backingOff: Number(row.backing_off),
    gaveUp: Number(row.gave_up),
  };
}

export interface EmbeddingPumpOptions extends EmbeddingOptions {
  /** The wait after a pass that emptied the queue. */
  readonly idleMs?: number;
  /** The first wait after a failing pass; it doubles, to `maxBackoffMs`. */
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Told what each pass did and how long the pump now waits. */
  readonly onPass?: (result: EmbeddingDrainResult, waitMs: number) => void;
  /** Told when a pass threw. The error is the caller's to redact. */
  readonly onError?: (error: unknown, waitMs: number) => void;
  /** Waiting, injectable so a test controls time. Must resolve when `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The pass, injectable so a test can count passes without an engine. */
  readonly drain?: typeof drainEmbeddings;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * The pump: a pass, then a wait — `idleMs` after a pass that emptied the queue or was stopped,
 * and a doubling backoff (from `backoffMs` to `maxBackoffMs`) after a pass the engine failed or
 * that threw, reset by the next pass that is not failing. One pass at a time, never two.
 */
export function startEmbeddingPump(
  pool: Pool,
  client: RetrievalClient,
  options: EmbeddingPumpOptions = {},
): { stop(): Promise<void> } {
  const idleMs = options.idleMs ?? 2_000;
  const firstBackoff = options.backoffMs ?? 2_000;
  const maxBackoff = options.maxBackoffMs ?? 300_000;
  const sleep = options.sleep ?? abortableSleep;
  const drain = options.drain ?? drainEmbeddings;
  const stopping = new AbortController();
  let backoff = firstBackoff;
  const failing = (): number => {
    const wait = backoff;
    backoff = Math.min(maxBackoff, backoff * 2);
    return wait;
  };
  const loop = (async () => {
    while (!stopping.signal.aborted) {
      let wait: number;
      try {
        const result = await drain(pool, client, {
          ...options,
          shouldStop: () => stopping.signal.aborted || options.shouldStop?.() === true,
        });
        if (result.stoppedBy === 'engine_unavailable' || result.stoppedBy === 'failing') {
          wait = failing();
        } else {
          backoff = firstBackoff;
          wait = idleMs;
        }
        options.onPass?.(result, wait);
      } catch (error: unknown) {
        wait = failing();
        options.onError?.(error, wait);
      }
      if (stopping.signal.aborted) break;
      await sleep(wait, stopping.signal);
    }
  })();
  return {
    async stop(): Promise<void> {
      stopping.abort();
      await loop;
    },
  };
}
