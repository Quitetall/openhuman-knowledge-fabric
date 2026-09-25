import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BandBitmaps } from './index.js';
import type { Tx } from '@kf/database';
import { RetrievalClient, type RetrievalOutcome } from './client.js';
import { SemanticRetrieval, type TransactionRunner } from './engine.js';
import { BANDS, type Band } from './protocol.js';

/**
 * The client against the real engine (LAMU `lamu kf-retrieval serve`, SAS §100.21).
 *
 * Opt-in: set `KF_RETRIEVAL_ENGINE_BIN` to a `lamu` binary built with the KF retrieval socket.
 * `client.test.ts` proves the client refuses a hostile engine; this proves the engine the client
 * will actually be pointed at satisfies the protocol from the other side — the handshake it
 * declares, a vectors-only write that persists no text (KF-SAS-RQ-213, RQ-225), a mask that is
 * never scored past (RQ-214, RQ-215), a `none` ceiling that returns nothing, an embedder binding
 * that does not change (RQ-218), and a store that is ciphertext without its key (ADR 0028).
 *
 * The engine runs its in-process hashing embedder: local by construction and reproducible, so
 * the guards can be proven without a model. It ranks by lexical overlap, not meaning.
 */

const ENGINE_BIN = process.env.KF_RETRIEVAL_ENGINE_BIN ?? '';
const ORG = '01a08b19-44b4-7e35-b465-d6c9a1f07f99';
const PIN = 'lamu-kf-hash-v1/d256';
const QUERY = 'second source supplier qualification commercial terms';

const RECORDS: readonly { id: string; band: Band; text: string }[] = [
  { id: '01a00000-0000-7000-8000-000000000001', band: 'public', text: 'canteen opening hours' },
  {
    id: '01a00000-0000-7000-8000-000000000002',
    band: 'public',
    text: 'supplier qualification checklist overview',
  },
  { id: '01a00000-0000-7000-8000-000000000003', band: 'internal', text: 'boiler maintenance' },
  {
    id: '01a00000-0000-7000-8000-000000000004',
    band: 'internal',
    text: 'supplier qualification audit notes',
  },
  {
    id: '01a00000-0000-7000-8000-000000000005',
    band: 'confidential',
    text: 'supplier commercial terms draft',
  },
  // The query's own text, restricted: ranks first whenever it is scorable at all.
  { id: '01a00000-0000-7000-8000-000000000006', band: 'restricted', text: QUERY },
];
/** The ids a ranking returned; a non-ranking fails the test rather than reading as empty. */
function hitIds(outcome: RetrievalOutcome): string[] {
  if (outcome.status !== 'ranked') throw new Error(`not ranked: ${outcome.reason}`);
  return outcome.hits.map((hit) => hit.objectId);
}

const bandOf = (id: string): Band | undefined => RECORDS.find((r) => r.id === id)?.band;

interface Engine {
  readonly child: ChildProcess;
  readonly socket: string;
}

function lamu(args: readonly string[], input?: string) {
  return spawnSync(ENGINE_BIN, ['kf-retrieval', ...args], { input, encoding: 'utf8' });
}

/** Start the engine and resolve once it says it is serving, or reject with what it said. */
function serveEngine(
  dir: string,
  keyFile: string,
  extra: readonly string[] = [],
  socket = join(dir, 'engine.sock'),
): Promise<Engine> {
  const args = [
    'kf-retrieval',
    'serve',
    '--socket',
    socket,
    '--store',
    join(dir, 'store'),
    '--key-file',
    keyFile,
    '--embedder',
    'hash-v1',
    '--socket-mode',
    '600',
    ...(extra.length > 0 ? extra : ['--pin-embedder', PIN]),
  ];
  const child = spawn(ENGINE_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.includes('serving')) resolve({ child, socket });
    });
    child.on('exit', (code) => reject(new Error(`engine exited ${String(code)}: ${stderr}`)));
  });
}

function stop(engine: Engine): Promise<void> {
  return new Promise((resolve) => {
    if (engine.child.exitCode !== null) return resolve();
    engine.child.once('exit', () => resolve());
    engine.child.kill('SIGTERM');
  });
}

function storeBytes(dir: string): Buffer {
  const store = join(dir, 'store');
  return Buffer.concat(readdirSync(store).map((name) => readFileSync(join(store, name))));
}

function bitmaps(generation: string, objectIds: readonly string[], bandVersion: string) {
  const bands = Object.fromEntries(
    BANDS.map((band) => [
      band,
      Uint8Array.from(objectIds.map((id) => (bandOf(id) === band ? 1 : 0))),
    ]),
  ) as Record<Band, Uint8Array>;
  return {
    organizationId: ORG,
    bandVersion,
    generation,
    slotCount: objectIds.length,
    bands,
    unresolved: Uint8Array.from(objectIds.map((id) => (bandOf(id) === undefined ? 1 : 0))),
  } satisfies BandBitmaps;
}

describe.runIf(ENGINE_BIN !== '')('the retrieval client against the real engine', () => {
  let dir: string;
  let keyFile: string;
  let engine: Engine;
  let client: RetrievalClient;
  let generation: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kf-real-engine-'));
    keyFile = join(dir, 'key');
    expect(lamu(['keygen', '--out', keyFile]).status).toBe(0);
    engine = await serveEngine(dir, keyFile);
    client = new RetrievalClient({ socketPath: engine.socket, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    if (engine) await stop(engine);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('declares protocol 1, a local pinned embedder and the vectors-only write', async () => {
    const probed = await client.probe('vectors_only_write');
    expect(probed).toMatchObject({ ok: true });
    const { hello } = probed as { hello: { embedder: unknown; protocol: number } };
    expect(hello.protocol).toBe(1);
    expect(hello.embedder).toEqual({ identity: PIN, local: true });
    expect(client.embedderIdentity).toBe(PIN);
  });

  it('writes every record through the vectors-only path and persists none of its text', async () => {
    for (const record of RECORDS) {
      const written = await client.writeVector({
        organizationId: ORG,
        objectId: record.id,
        text: record.text,
      });
      expect(written, record.id).toMatchObject({ ok: true });
    }
    const bytes = storeBytes(dir);
    for (const record of RECORDS) {
      for (const word of record.text.split(' ').filter((w) => w.length >= 5)) {
        expect(bytes.includes(word), `'${word}' is in the store bytes`).toBe(false);
      }
      // Encrypted at rest: not even the identifiers are readable.
      expect(bytes.includes(record.id), `${record.id} is in the store bytes`).toBe(false);
    }
  });

  it('builds bands over the engine slot ordering and has them accepted', async () => {
    const slots = await client.slots();
    expect(slots.status).toBe('slots');
    const { objectIds } = slots as { objectIds: readonly string[]; generation: string };
    generation = (slots as { generation: string }).generation;
    expect([...objectIds]).toEqual(RECORDS.map((r) => r.id));
    expect(await client.pushBands(bitmaps(generation, objectIds, 'e1.1'))).toEqual({ ok: true });
  });

  const search = (ceiling: Band | 'none', allow: readonly string[] = [], bandVersion = 'e1.1') =>
    client.search({
      organizationId: ORG,
      bandVersion,
      generation,
      ceiling,
      allow,
      deny: [],
      query: QUERY,
      k: 100,
    });

  it('never returns a record the mask excludes, and returns every one it admits', async () => {
    for (const ceiling of ['public', 'internal', 'confidential'] as const) {
      const outcome = await search(ceiling);
      expect(outcome.status).toBe('ranked');
      const ids = hitIds(outcome);
      const admitted = RECORDS.filter((r) => BANDS.indexOf(r.band) <= BANDS.indexOf(ceiling)).map(
        (r) => r.id,
      );
      expect(ids.sort()).toEqual([...admitted].sort());
      expect(outcome).toMatchObject({ ranking: 'lamu.kf.masked-cosine.v1' });
      expect((outcome as { traceDigest: string }).traceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const all = await search('restricted');
    expect(hitIds(all)[0]).toBe(RECORDS[5]?.id);
  });

  it('returns nothing at a none ceiling, and only the allow list when there is one', async () => {
    expect(await search('none')).toMatchObject({ status: 'ranked', hits: [] });
    const allowed = await search('none', [RECORDS[4]!.id]);
    expect(hitIds(allowed)).toEqual([RECORDS[4]!.id]);
  });

  it('refuses a stale band version, asking for a rebuild rather than answering', async () => {
    expect(await search('public', [], 'e1.0')).toMatchObject({
      status: 'unavailable',
      rebuildBands: true,
    });
  });

  it('finds a record whose vector lands after its band version moved', async () => {
    // The act that records LATE moves the band version in its own transaction; the worker's pump
    // writes LATE's vector afterwards, and nothing moves the band version again.
    const late = { id: '01a00000-0000-7000-8000-000000000007', band: 'public' as const };
    const bandOfNow = (id: string): Band | undefined => (id === late.id ? late.band : bandOf(id));
    const run: TransactionRunner = (fn) =>
      fn({
        query: async (sql: string, params: readonly unknown[]) => {
          if (sql.includes('retrieval.band-version')) return [{ epoch: 'e2', version: '1' }];
          if (sql.includes('retrieval.slot-bands')) {
            return (params[1] as string[]).map((id, index) => ({
              slot: index + 1,
              classification: bandOfNow(id) ?? null,
            }));
          }
          return [];
        },
      } as unknown as Tx);
    const semantic = new SemanticRetrieval(client);
    const ask = () =>
      semantic.rank(run, {
        organizationId: ORG,
        clearance: 'restricted',
        coverage: {
          organizationWide: [
            {
              source: 'test',
              sourceId: 'org',
              scopeObjectId: 'org',
              classificationCeiling: null,
              reason: 'test',
            },
          ],
          byObject: new Map(),
        },
        query: QUERY,
        k: 100,
      });

    expect(hitIds(await ask())).not.toContain(late.id);
    const written = await client.writeVector({
      organizationId: ORG,
      objectId: late.id,
      text: `${QUERY} late`,
    });
    expect(written).toMatchObject({ ok: true });
    expect(hitIds(await ask()), 'the new slot must not stay padded closed').toContain(late.id);
  });

  it('keeps no record text even in the decrypted store, and the audit can see what is there', () => {
    // The probe must be able to fail: an object id IS in the decrypted store.
    const positive = lamu(
      ['audit', '--store', join(dir, 'store'), '--key-file', keyFile, '--needle-stdin'],
      RECORDS[0]!.id,
    );
    expect(positive.status, positive.stderr).toBe(3);
    for (const record of RECORDS) {
      const audit = lamu(
        ['audit', '--store', join(dir, 'store'), '--key-file', keyFile, '--needle-stdin'],
        record.text,
      );
      expect(audit.status, `${record.id}: ${audit.stdout}${audit.stderr}`).toBe(0);
      expect(JSON.parse(audit.stdout)).toMatchObject({ needleFound: false, embedder: PIN });
    }
  });

  it('will not open the store under another key, or under another embedder', async () => {
    await stop(engine);
    const otherKey = join(dir, 'other-key');
    expect(lamu(['keygen', '--out', otherKey]).status).toBe(0);
    await expect(serveEngine(dir, otherKey)).rejects.toThrow(/does not open under this key/);
    await expect(
      serveEngine(dir, keyFile, ['--hash-dims', '128', '--pin-embedder', 'lamu-kf-hash-v1/d128']),
    ).rejects.toThrow(/embedder mismatch/);
    await expect(
      serveEngine(dir, keyFile, ['--hash-dims', '128', '--pin-embedder', PIN]),
    ).rejects.toThrow(/embedder mismatch/);
    engine = await serveEngine(dir, keyFile);
    // Bands are memory-only: a restarted engine has none, and says so rather than answering.
    expect(await search('public')).toMatchObject({ status: 'unavailable', rebuildBands: true });
  });

  it('is refused by the client when a restarted engine names a different embedder', async () => {
    await stop(engine);
    const fresh = mkdtempSync(join(tmpdir(), 'kf-real-engine-other-'));
    try {
      // Same socket the client already speaks to; a fresh store under another embedder.
      engine = await serveEngine(
        fresh,
        keyFile,
        ['--hash-dims', '128', '--pin-embedder', 'lamu-kf-hash-v1/d128'],
        engine.socket,
      );
      const outcome = await client.probe();
      expect(outcome).toMatchObject({ status: 'unavailable' });
      expect((outcome as { reason: string }).reason).toMatch(/d256.*d128/);
    } finally {
      await stop(engine);
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
