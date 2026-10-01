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

    const result = await drainEmbeddings(workerPool, client, { leaseSeconds: 1 });
    expect(result.embedded).toBe(0);
    expect(result.failed.map((failure) => failure.objectId)).toContain(id);
    expect(engine.received, 'record text reached a path that may persist it').not.toContain(
      'write_vector',
    );
    expect(await pending(), 'an unembedded record stays queued').toContain(id);
  });
});
