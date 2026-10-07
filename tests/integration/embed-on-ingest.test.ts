/**
 * Embed on ingest (§64A, KF-SAS-RQ-218, RQ-225), against a stub engine on a real unix socket.
 *
 * An act commits; the outbox drain queues what it touched; the embedding pump hands each record's
 * text to the engine's vectors-only write with no database transaction open, and completes it.
 * An engine that does not declare that write path is refused at startup and is never sent text.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '@kf/actions';
import { createPool, withTransaction, type Pool } from '@kf/database';
import { RetrievalClient, RETRIEVAL_PROTOCOL_VERSION, encode } from '@kf/retrieval';
import {
  drainEmbeddings,
  embeddingOutboxHandler,
  requireVectorsOnlyEngine,
} from '../../apps/worker/src/embedding.js';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;
let workerPool: Pool;
let workerRole: string;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  workerRole = `kf_worker_embed_${randomUUID().replaceAll('-', '')}`;
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`create role ${workerRole} login password 'test-only-not-a-secret' inherit`);
    await tx.query(`grant kf_worker to ${workerRole}`);
  });
  const uri = new URL(h.connectionString);
  uri.username = workerRole;
  uri.password = 'test-only-not-a-secret';
  workerPool = createPool({ connectionString: uri.toString() });
}, 180_000);

afterAll(async () => {
  await workerPool?.end();
  await h?.stop();
});

async function acceptSomething(title: string): Promise<string> {
  const id = await createObject(h.adminPool, f, {
    type: 'decision_record',
    domain: 'engineering',
    state: 'proposed',
    title,
    createdBy: f.performerId,
  });
  await createDispatcher(h.pool)({
    actionType: 'accept_decision',
    actorId: f.reviewerId,
    actingRoleId: f.reviewerRoleId,
    targetIds: [id],
    idempotencyKey: `embed-${randomUUID()}`,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
  });
  return id;
}

async function pending(): Promise<string[]> {
  const rows = await withTransaction(h.adminPool, (tx) =>
    tx.query<{ object_id: string }>('select object_id from retrieval.embed_pending order by 1'),
  );
  return rows.map((row) => row.object_id);
}

interface Written {
  readonly objectId: string;
  readonly text: string;
  /** Transactions the worker's login held open at the moment the engine received the text. */
  readonly openTransactions: number;
}

let active: { server: Server; dir: string } | undefined;

afterEach(() => {
  active?.server.close();
  if (active) rmSync(active.dir, { recursive: true, force: true });
  active = undefined;
});

function stubEngine(
  capabilities: string[],
  delayMs = 0,
  sampleWhenWriters = 1,
): {
  path: string;
  received: string[];
  written: Written[];
  peakWriters: () => number;
} {
  const dir = mkdtempSync(join(tmpdir(), 'kf-embed-'));
  const path = join(dir, 'engine.sock');
  const received: string[] = [];
  const written: Written[] = [];
  let writers = 0;
  let peak = 0;
  const waiting: { objectId: string; text: string; socket: Socket }[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, string>;
        buffer = buffer.slice(newline + 1);
        received.push(message['type']!);
        if (message['type'] === 'hello') {
          socket.write(
            encode({
              type: 'hello_ok',
              protocol: RETRIEVAL_PROTOCOL_VERSION,
              engine: 'stub/1',
              generation: 'g1',
              slotCount: 0,
              embedder: { identity: 'local:stub', local: true },
              capabilities,
            }),
          );
        } else if (message['type'] === 'write_vector') {
          writers += 1;
          peak = Math.max(peak, writers);
          const objectId = message['objectId']!;
          const text = message['text']!;
          waiting.push({ objectId, text, socket });
          if (waiting.length === sampleWhenWriters) {
            const batch = waiting.splice(0);
            // With concurrent consumers, a completed sibling may hold its short
            // completion transaction. Sample only when every consumer awaits
            // inference, before acknowledging any member of this cohort.
            void withTransaction(h.adminPool, (tx) =>
              tx.one<{ open: number }>(
                `select count(*)::int as open from pg_stat_activity
                where usename = $1 and state like 'idle in transaction%'`,
                [workerRole],
              ),
            ).then(({ open }) => {
              for (const row of batch)
                written.push({ objectId: row.objectId, text: row.text, openTransactions: open });
              setTimeout(() => {
                writers -= batch.length;
                for (const row of batch)
                  row.socket.write(
                    encode({ type: 'write_vector_ok', objectId: row.objectId, generation: 'g1' }),
                  );
              }, delayMs);
            });
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
  });
  server.listen(path);
  active = { server, dir };
  return { path, received, written, peakWriters: () => peak };
}

/** Deterministically keep one completed sibling idle briefly, never its inference request. */
async function withDelayedFirstCompletion<T>(fn: () => Promise<T>): Promise<T> {
  const connect = workerPool.connect.bind(workerPool);
  const wrapped = new WeakSet<object>();
  const restore: (() => void)[] = [];
  let completions = 0;
  const spy = vi.spyOn(workerPool, 'connect').mockImplementation(async () => {
    const connection = await connect();
    if (!wrapped.has(connection)) {
      wrapped.add(connection);
      const original = connection.query;
      restore.push(() => {
        connection.query = original;
      });
      const query = connection.query.bind(connection);
      connection.query = (...args: unknown[]) => {
        const outcome = Reflect.apply(query, connection, args);
        if (typeof args[0] === 'string' && args[0].includes('retrieval.complete_embedding')) {
          completions += 1;
          if (completions === 1)
            return Promise.resolve(outcome).then(async (result) => {
              await new Promise((resolve) => setTimeout(resolve, 300));
              return result;
            });
        }
        return outcome;
      };
    }
    return connection;
  });
  try {
    return await fn();
  } finally {
    spy.mockRestore();
    for (const reset of restore) reset();
  }
}

describe('embed on ingest (KF-SAS-RQ-225)', () => {
  it('overlaps engine requests within the configured bound, without holding a transaction', async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) => acceptSomething(`Bounded embedding work ${i}`)),
    );
    await drainOutbox(workerPool, { handlers: { '*': embeddingOutboxHandler } });
    expect(await pending()).toHaveLength(6); // Three complete cohorts of two consumers.
    const engine = stubEngine(['vectors_only_write'], 40, 2);
    const client = new RetrievalClient({ socketPath: engine.path, timeoutMs: 2_000 });
    const result = await withDelayedFirstCompletion(() =>
      drainEmbeddings(workerPool, client, { concurrency: 2 }),
    );
    expect(result.failed).toEqual([]);
    expect(engine.peakWriters()).toBe(2);
    for (const id of ids) expect(engine.written.map((row) => row.objectId)).toContain(id);
    expect(engine.written.every((row) => row.openTransactions === 0)).toBe(true);
    for (const id of ids) expect(await pending()).not.toContain(id);
  });

  it.each([0, -1, 1.5, 17, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses concurrency %s before claiming work',
    async (concurrency) => {
      const engine = stubEngine(['vectors_only_write']);
      const before = await pending();
      await expect(
        drainEmbeddings(workerPool, new RetrievalClient({ socketPath: engine.path }), {
          concurrency,
        }),
      ).rejects.toThrow(/embedding concurrency/);
      expect(await pending()).toEqual(before);
      expect(engine.received).toEqual([]);
    },
  );

  it('queues what an act touched and embeds it with no transaction open', async () => {
    const id = await acceptSomething('Heat exchanger fouling allowance');
    const drained = await drainOutbox(workerPool, { handlers: { '*': embeddingOutboxHandler } });
    expect(drained.failed).toBe(0);
    expect(await pending()).toContain(id);

    const engine = stubEngine(['vectors_only_write']);
    const client = new RetrievalClient({ socketPath: engine.path, timeoutMs: 2_000 });
    await requireVectorsOnlyEngine(client);
    const result = await drainEmbeddings(workerPool, client);

    expect(result.failed).toEqual([]);
    expect(result.embedded).toBeGreaterThanOrEqual(1);
    const mine = engine.written.find((write) => write.objectId === id);
    expect(mine?.text).toContain('Heat exchanger fouling allowance');
    expect(
      engine.written.map((write) => write.openTransactions),
      'the worker held a database transaction open while the engine worked',
    ).toEqual(engine.written.map(() => 0));
    expect(await pending()).not.toContain(id);
  });

  it('refuses at startup, and sends no text to, an engine without a vectors-only write path', async () => {
    const id = await acceptSomething('Condenser tube plugging criteria');
    await drainOutbox(workerPool, { handlers: { '*': embeddingOutboxHandler } });
    expect(await pending()).toContain(id);

    const engine = stubEngine([]);
    const client = new RetrievalClient({ socketPath: engine.path, timeoutMs: 2_000 });
    await expect(requireVectorsOnlyEngine(client)).rejects.toThrow(/vectors_only_write/);

    // Asked before anything is claimed: the pass ends with the engine's reason, claims nothing, and
    // costs the record no attempt.
    const result = await drainEmbeddings(workerPool, client);
    expect(result.stoppedBy).toBe('engine_unavailable');
    expect(result.reason).toMatch(/vectors_only_write/);
    expect(result.claimed).toBe(0);
    expect(engine.received, 'record text reached a path that may persist it').not.toContain(
      'write_vector',
    );
    expect(await pending(), 'an unembedded record stays queued').toContain(id);
    const [row] = await queueRows([id]);
    expect(row).toMatchObject({ claim: null, attempts: 0, failed_at: null });
    await clearQueue();
  });
});

// --- The pump in bounded time (SAS §100.44) ------------------------------------------------------

type QueueRow = {
  readonly object_id: string;
  readonly claim: string | null;
  readonly attempts: number;
  readonly requeued: boolean;
  readonly failed_at: Date | null;
  readonly failure: string | null;
  readonly backing_off: boolean;
};

async function queueRows(ids: readonly string[]): Promise<QueueRow[]> {
  return withTransaction(h.adminPool, (tx) =>
    tx.query<QueueRow>(
      `select object_id, claim, attempts, requeued, failed_at, failure,
              coalesce(claim is null and claimed_until > now(), false) as backing_off
         from retrieval.embed_pending where object_id = any($1::uuid[]) order by object_id`,
      [ids],
    ),
  );
}

async function clearQueue(): Promise<void> {
  await withTransaction(h.adminPool, (tx) => tx.query('delete from retrieval.embed_pending'));
}

async function enqueue(ids: readonly string[]): Promise<void> {
  await withTransaction(h.adminPool, (tx) =>
    tx.query('select retrieval.enqueue_embedding($1::uuid[])', [ids]),
  );
}

/** Records, created directly (no act) and queued: what a large ingest leaves behind. */
async function queuedRecords(count: number, label: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(
      await createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'proposed',
        title: `${label} ${i}`,
        createdBy: f.performerId,
      }),
    );
  }
  await enqueue(ids);
  return ids;
}

interface Write {
  readonly objectId: string;
  readonly startedAt: number;
  endedAt?: number;
}

/**
 * An engine whose every write is decided by `decide`: how long it takes, and whether it is refused.
 * Records when each write began and was answered, and the most writes it ever had in flight.
 */
function programmableEngine(
  decide: (objectId: string, ordinal: number) => { delayMs: number; refuse?: boolean },
  onWrite?: (objectId: string) => Promise<void> | void,
): { path: string; writes: Write[]; peak: () => number; hellos: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'kf-embed-'));
  const path = join(dir, 'engine.sock');
  const writes: Write[] = [];
  let inFlight = 0;
  let peak = 0;
  let hellos = 0;
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, string>;
        buffer = buffer.slice(newline + 1);
        if (message['type'] === 'hello') {
          hellos += 1;
          socket.write(
            encode({
              type: 'hello_ok',
              protocol: RETRIEVAL_PROTOCOL_VERSION,
              engine: 'stub/1',
              generation: 'g1',
              slotCount: 0,
              embedder: { identity: 'local:stub', local: true },
              capabilities: ['vectors_only_write'],
            }),
          );
        } else if (message['type'] === 'write_vector') {
          const objectId = message['objectId']!;
          const write: Write = { objectId, startedAt: performance.now() };
          writes.push(write);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          const { delayMs, refuse } = decide(objectId, writes.length);
          void Promise.resolve(onWrite?.(objectId)).then(() =>
            setTimeout(() => {
              inFlight -= 1;
              write.endedAt = performance.now();
              socket.write(
                encode(
                  refuse === true
                    ? { type: 'error', code: 'embedder_unavailable', detail: 'the stub refuses' }
                    : { type: 'write_vector_ok', objectId, generation: 'g1' },
                ),
              );
            }, delayMs),
          );
        }
        newline = buffer.indexOf('\n');
      }
    });
  });
  server.listen(path);
  active = { server, dir };
  return { path, writes, peak: () => peak, hellos: () => hellos };
}

function writesOf(writes: readonly Write[], id: string): Write[] {
  return writes.filter((write) => write.objectId === id);
}

describe('the embedding pump drains in bounded time (SAS §100.44)', () => {
  it('keeps N requests in flight, never more, and drains the queue to empty', async () => {
    await clearQueue();
    const ids = await queuedRecords(40, 'Drain to empty');
    const engine = programmableEngine((_, n) => ({ delayMs: 5 + ((n * 7) % 11) }));
    const client = new RetrievalClient({ socketPath: engine.path, timeoutMs: 2_000 });
    const result = await drainEmbeddings(workerPool, client, { concurrency: 4 });

    expect(result).toMatchObject({ claimed: 40, embedded: 40, stoppedBy: 'empty', failed: [] });
    expect(engine.peak()).toBe(4);
    for (const id of ids) expect(writesOf(engine.writes, id)).toHaveLength(1);
    expect(await pending()).toEqual([]);
  });

  it('never embeds a record twice when workers race, and embeds an edit after the old text, never beside it', async () => {
    await clearQueue();
    const ids = await queuedRecords(30, 'Racing workers');
    const edited = new Set(ids.slice(0, 6));
    const reEnqueued = new Set<string>();
    // While each of the first six is being embedded, its record is edited (enqueued again), and
    // that first embedding is slow, so free consumers come back to the queue while it is in flight.
    const engine = programmableEngine(
      (objectId) => ({ delayMs: edited.has(objectId) && !reEnqueued.has(objectId) ? 400 : 5 }),
      async (objectId) => {
        if (edited.has(objectId) && !reEnqueued.has(objectId)) {
          reEnqueued.add(objectId);
          await enqueue([objectId]);
        }
      },
    );
    const client = () => new RetrievalClient({ socketPath: engine.path, timeoutMs: 2_000 });
    // Two workers, each with four consumers, over one queue.
    const [first, second] = await Promise.all([
      drainEmbeddings(workerPool, client(), { concurrency: 4 }),
      drainEmbeddings(workerPool, client(), { concurrency: 4 }),
    ]);
    expect([...first.failed, ...second.failed]).toEqual([]);
    expect(first.embedded + second.embedded).toBe(36);
    expect(reEnqueued.size).toBe(6);

    for (const id of ids) {
      const mine = writesOf(engine.writes, id);
      if (!edited.has(id)) {
        expect(mine, `record ${id} was embedded more than once`).toHaveLength(1);
        continue;
      }
      // Twice: the old text, then the new one — the second begun only after the first answered.
      expect(mine, `edited record ${id}`).toHaveLength(2);
      expect(
        mine[1]!.startedAt,
        `edited record ${id} was embedded again while its old text was still being embedded`,
      ).toBeGreaterThanOrEqual(mine[0]!.endedAt!);
    }
    expect(await pending()).toEqual([]);
  });

  it('refuses a lease that could lapse while its holder still waits on the engine', async () => {
    const engine = programmableEngine(() => ({ delayMs: 0 }));
    await expect(
      drainEmbeddings(workerPool, new RetrievalClient({ socketPath: engine.path }), {
        leaseSeconds: 10,
        engineTimeoutMs: 6_000,
      }),
    ).rejects.toThrow(/at least twice the engine timeout/);
    expect(engine.hellos()).toBe(0);
  });
});

describe('a failing embedder backs off, then is recorded (SAS §100.44)', () => {
  it('stops a pass after consecutive failures, backs each record off, and records it after the last attempt', async () => {
    await clearQueue();
    const ids = await queuedRecords(12, 'Refused by the engine');
    const engine = programmableEngine(() => ({ delayMs: 2, refuse: true }));
    const client = new RetrievalClient({ socketPath: engine.path, timeoutMs: 2_000 });
    const policy = { concurrency: 2, failureLimit: 4, backoffBaseSeconds: 1, maxAttempts: 2 };

    // Pass 1: the engine fails four in a row and the pass stops; the rest are not tried.
    const one = await drainEmbeddings(workerPool, client, policy);
    expect(one.stoppedBy).toBe('failing');
    expect(engine.writes.length, 'a failing engine kept being sent records').toBeLessThanOrEqual(
      policy.failureLimit + policy.concurrency - 1,
    );
    const tried = new Set(engine.writes.map((write) => write.objectId));
    expect(one.failed.every((f) => f.failure === 'engine_refused' && f.outcome === 'retry')).toBe(
      true,
    );
    for (const row of await queueRows([...tried])) {
      expect(row).toMatchObject({ attempts: 1, claim: null, failed_at: null, backing_off: true });
    }

    // Pass 2, at once: nothing tried in pass 1 is sent again while it backs off.
    const before = engine.writes.length;
    await drainEmbeddings(workerPool, client, policy);
    const retriedEarly = engine.writes.slice(before).filter((write) => tried.has(write.objectId));
    expect(retriedEarly, 'a record was retried before its backoff ran out').toEqual([]);

    // After the backoff: the second attempt fails too, and the pump gives up and records it.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    for (let pass = 0; pass < 6; pass += 1) {
      await drainEmbeddings(workerPool, client, { ...policy, failureLimit: 1000 });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await drainEmbeddings(workerPool, client, { ...policy, failureLimit: 1000 });
    const rows = await queueRows(ids);
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row).toMatchObject({ attempts: 2, failure: 'engine_refused', claim: null });
      expect(row.failed_at, `record ${row.object_id} was not recorded as given up`).not.toBeNull();
    }
    for (const id of ids) expect(writesOf(engine.writes, id)).toHaveLength(2);

    // Given up: no later pass sends it again.
    const settled = engine.writes.length;
    const after = await drainEmbeddings(workerPool, client, policy);
    expect(after).toMatchObject({ claimed: 0, stoppedBy: 'empty' });
    expect(engine.writes.length).toBe(settled);

    // Enqueued again (an edit, or a reindex): its count is cleared and it is tried at once.
    await enqueue(ids.slice(0, 1));
    const [reset] = await queueRows(ids.slice(0, 1));
    expect(reset).toMatchObject({ attempts: 0, failed_at: null, failure: null });
    await clearQueue();
  });

  it('claims nothing, and costs no record an attempt, while the engine cannot be reached', async () => {
    await clearQueue();
    const ids = await queuedRecords(3, 'Engine down');
    const dead = new RetrievalClient({
      socketPath: join(tmpdir(), `kf-absent-${randomUUID()}.sock`),
    });
    const result = await drainEmbeddings(workerPool, dead);
    expect(result).toMatchObject({ claimed: 0, stoppedBy: 'engine_unavailable' });
    for (const row of await queueRows(ids)) {
      expect(row).toMatchObject({ attempts: 0, claim: null, failed_at: null, backing_off: false });
    }
    await clearQueue();
  });
});

describe('a pass that fails ends with all of its consumers (SAS §100.44)', () => {
  it('waits for every consumer before it throws, so the next pass never runs beside them', async () => {
    await clearQueue();
    await queuedRecords(20, 'Claim refused');
    const engine = programmableEngine(() => ({ delayMs: 60 }));
    const client = new RetrievalClient({ socketPath: engine.path, timeoutMs: 2_000 });
    const connect = workerPool.connect.bind(workerPool);
    let claims = 0;
    const spy = vi.spyOn(workerPool, 'connect').mockImplementation(async () => {
      const connection = await connect();
      const query = connection.query.bind(connection) as (...args: unknown[]) => unknown;
      (connection as unknown as { query: unknown }).query = (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('retrieval.claim_embeddings')) {
          claims += 1;
          // The fifth claim: the database refuses it (a lock timeout under load, say).
          if (claims === 5)
            return Promise.reject(new Error('canceling statement due to lock timeout'));
        }
        return query(...args);
      };
      return connection;
    });
    try {
      await expect(drainEmbeddings(workerPool, client, { concurrency: 4 })).rejects.toThrow(
        /lock timeout/,
      );
    } finally {
      spy.mockRestore();
    }
    const settledAt = engine.writes.length;
    // Nothing the failed pass started is still running: no write begins after it returned.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(engine.writes.length).toBe(settledAt);
    expect(engine.writes.every((write) => write.endedAt !== undefined)).toBe(true);
    await clearQueue();
  });
});
