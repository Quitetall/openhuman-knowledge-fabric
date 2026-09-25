import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessCoverage, AccessGrantRef } from '@kf/authorization';
import type { Tx } from '@kf/database';
import { RetrievalClient, type RetrievalOutcome } from './client.js';
import { engineScope, SemanticRetrieval, type TransactionRunner } from './engine.js';
import { encode, RETRIEVAL_PROTOCOL_VERSION } from './protocol.js';

/**
 * What the engine is told to score is the caller's GRANTS, not their clearance (ADR 0016,
 * ADR 0027, KF-SAS-RQ-213). A clearance alone reads nothing, so a ceiling taken from it would let
 * the engine score records nobody granted.
 */

function grant(scope: string, ceiling: string | null): AccessGrantRef {
  return {
    source: 'test',
    sourceId: scope,
    scopeObjectId: scope,
    classificationCeiling: ceiling,
    reason: 'test',
  };
}

/** Row security as the fake applies it: objects above the session clearance are not returned. */
function visibleAt(clearance: string, objects: Record<string, string>): Tx {
  const rank = ['public', 'internal', 'confidential', 'restricted'];
  return {
    query: async (_sql: string, params: readonly unknown[]) =>
      ((params[0] as string[]) ?? [])
        .filter((id) => objects[id] !== undefined)
        .filter((id) => rank.indexOf(objects[id]!) <= rank.indexOf(clearance))
        .map((id) => ({ id, classification: objects[id]! })),
  } as unknown as Tx;
}

const coverage = (
  organizationWide: AccessGrantRef[],
  byObject: [string, AccessGrantRef[]][] = [],
): AccessCoverage => ({ organizationWide, byObject: new Map(byObject) });

describe('the engine scope is the grant-capped ceiling plus the object grants', () => {
  it('caps the ceiling at the organization-wide grant, below the clearance', async () => {
    const scope = await engineScope(
      visibleAt('restricted', {}),
      'restricted',
      coverage([grant('org', 'internal')]),
    );
    expect(scope).toEqual({ ceiling: 'internal', allow: [] });
  });

  it('caps the ceiling at the clearance, below an unbounded grant', async () => {
    const scope = await engineScope(
      visibleAt('confidential', {}),
      'confidential',
      coverage([grant('org', null)]),
    );
    expect(scope.ceiling).toBe('confidential');
  });

  it('scores no band at all when no organization-wide grant reaches one', async () => {
    const scope = await engineScope(visibleAt('restricted', {}), 'restricted', coverage([]));
    expect(scope.ceiling, 'a clearance alone must not open a band').toBe('none');
  });

  it('allows an object-granted record at or below the clearance, and none above it', async () => {
    const tx = visibleAt('internal', { a: 'internal', b: 'restricted', c: 'public' });
    const scope = await engineScope(
      tx,
      'internal',
      coverage(
        [],
        [
          ['a', [grant('a', null)]],
          ['b', [grant('b', null)]],
          ['c', [grant('c', 'public')]],
        ],
      ),
    );
    expect(scope).toEqual({ ceiling: 'none', allow: ['a', 'c'] });
  });

  it('does not allow an object whose grant ceiling is below its classification', async () => {
    const tx = visibleAt('restricted', { a: 'confidential' });
    const scope = await engineScope(
      tx,
      'restricted',
      coverage([], [['a', [grant('a', 'internal')]]]),
    );
    expect(scope.allow).toEqual([]);
  });
});

/**
 * A new slot is not left padded closed (§64A, KF-SAS-RQ-215).
 *
 * The band version moves in the act's own transaction; the vector is written later, by the
 * worker's embedding pump. So the bitmaps cached for the current band version can be built over
 * an index one record short, and the band version does not move again when the vector lands. A
 * cache keyed on the band version alone then keeps pushing nothing, the engine pads the new slot
 * closed, and the record stays unfindable by meaning until some unrelated record in the
 * organization is reclassified. The engine's handshake says how many slots it holds; bitmaps
 * built for fewer are rebuilt.
 */
describe('semantic ranking sees a slot written after the band version moved', () => {
  const ORG = '01a08b19-44b4-7e35-b465-d6c9a1f07f99';
  const A = '01a00000-0000-7000-8000-00000000000a';
  const B = '01a00000-0000-7000-8000-00000000000b';
  let server: Server | undefined;
  let dir: string | undefined;

  afterEach(() => {
    server?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    server = undefined;
    dir = undefined;
  });

  /** An engine holding `slots`, padding a short mask closed as the real one does. */
  function fakeEngine(slots: string[]): { socketPath: string; pushes: number[] } {
    dir = mkdtempSync(join(tmpdir(), 'kf-retrieval-engine-'));
    const socketPath = join(dir, 'engine.sock');
    const pushes: number[] = [];
    let bandsSlotCount = 0;
    server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const message = JSON.parse(buffer.slice(0, newline)) as {
            type: string;
            slotCount?: number;
          };
          buffer = buffer.slice(newline + 1);
          if (message.type === 'hello') {
            socket.write(
              encode({
                type: 'hello_ok',
                protocol: RETRIEVAL_PROTOCOL_VERSION,
                engine: 'fake/0.1',
                generation: 'g1',
                slotCount: slots.length,
                embedder: { identity: 'local:test', local: true },
              }),
            );
          } else if (message.type === 'slots') {
            socket.write(encode({ type: 'slots_ok', generation: 'g1', objectIds: [...slots] }));
          } else if (message.type === 'bands') {
            bandsSlotCount = message.slotCount ?? 0;
            pushes.push(bandsSlotCount);
            socket.write(encode({ type: 'bands_ok', bandVersion: 'v', generation: 'g1' }));
          } else if (message.type === 'search') {
            // Every record here is public and the caller reaches public; a slot past the pushed
            // bands is padded closed and never scored.
            const hits = slots
              .slice(0, bandsSlotCount)
              .map((objectId, index) => ({ objectId, score: 1 - index / 10, rank: index + 1 }));
            socket.write(encode({ type: 'results', hits, traceDigest: 'sha256:00' }));
          }
          newline = buffer.indexOf('\n');
        }
      });
    });
    server.listen(socketPath);
    return { socketPath, pushes };
  }

  /** The database as the ranking reads it: one band version that does not move, all public. */
  const run: TransactionRunner = (fn) =>
    fn({
      query: async (sql: string, params: readonly unknown[]) => {
        if (sql.includes('retrieval.band-version')) return [{ epoch: 'e1', version: '1' }];
        if (sql.includes('retrieval.slot-bands')) {
          return (params[1] as string[]).map((_, index) => ({
            slot: index + 1,
            classification: 'public',
          }));
        }
        return [];
      },
    } as unknown as Tx);

  const query = {
    organizationId: ORG,
    clearance: 'restricted',
    coverage: coverage([grant('org', null)]),
    query: 'supplier qualification',
    k: 10,
  };

  const ids = (outcome: RetrievalOutcome): string[] => {
    if (outcome.status !== 'ranked') throw new Error(`not ranked: ${outcome.reason}`);
    return outcome.hits.map((hit) => hit.objectId);
  };

  it('rebuilds the bitmaps when the engine holds more slots than they cover', async () => {
    const slots = [A];
    const engine = fakeEngine(slots);
    const semantic = new SemanticRetrieval(new RetrievalClient({ socketPath: engine.socketPath }));

    expect(ids(await semantic.rank(run, query))).toEqual([A]);

    // The worker's pump writes B's vector. The band version moved when B was recorded, before
    // the first query, and does not move again.
    slots.push(B);

    expect(ids(await semantic.rank(run, query)), 'B must not stay padded closed').toEqual([A, B]);
    expect(engine.pushes).toEqual([1, 2]);
  });

  it('reuses the bitmaps while the engine holds the slots they cover', async () => {
    const engine = fakeEngine([A, B]);
    const semantic = new SemanticRetrieval(new RetrievalClient({ socketPath: engine.socketPath }));
    await semantic.rank(run, query);
    await semantic.rank(run, query);
    expect(engine.pushes).toEqual([2]);
  });
});
