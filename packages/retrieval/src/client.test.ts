import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BandBitmaps } from './index.js';
import { RetrievalClient, withheldForUnavailable } from './client.js';
import {
  encode,
  packBits,
  unpackBits,
  RETRIEVAL_PROTOCOL_VERSION,
  type ServerMessage,
} from './protocol.js';

/**
 * There is no partial answer (§64A, KF-SAS-RQ-216).
 *
 * Every branch below is a way the engine can fail, and every one must produce `unavailable`. A
 * caller who receives four hits cannot tell whether four is the answer or whether the engine fell
 * over after four, and an agent given a short list acts on it as complete. These run against a
 * real unix socket with a deliberately hostile engine on the other end, because the interesting
 * failures — a half-written line, a connection dropped mid-answer, silence — are not expressible
 * against a mock.
 */

const BITMAPS: BandBitmaps = {
  organizationId: '01a08b19-44b4-7e35-b465-d6c9a1f07f99',
  bandVersion: 7n,
  generation: 'tv-0001',
  slotCount: 3,
  bands: {
    public: Uint8Array.from([1, 0, 0]),
    internal: Uint8Array.from([0, 1, 0]),
    confidential: Uint8Array.from([0, 0, 0]),
    restricted: Uint8Array.from([0, 0, 1]),
  },
  unresolved: Uint8Array.from([0, 0, 0]),
};

const HELLO_OK: ServerMessage = {
  type: 'hello_ok',
  protocol: RETRIEVAL_PROTOCOL_VERSION,
  engine: 'fake/0.1',
  generation: 'tv-0001',
  slotCount: 3,
  embedder: { identity: 'local:bge-small', local: true },
};

let active: { server: Server; dir: string } | undefined;

/** An engine that answers each received line with the next scripted reply, or misbehaves. */
function engine(behaviour: (socket: Socket, line: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'kf-retrieval-'));
  const path = join(dir, 'engine.sock');
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        behaviour(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
  });
  server.listen(path);
  active = { server, dir };
  return path;
}

afterEach(() => {
  active?.server.close();
  if (active) rmSync(active.dir, { recursive: true, force: true });
  active = undefined;
});

/** Replies hello_ok then bands_ok, overriding the handshake with `hello` when given. */
function wellBehaved(hello: ServerMessage = HELLO_OK) {
  return (socket: Socket, line: string): void => {
    const message: { type: string } = JSON.parse(line);
    if (message.type === 'hello') socket.write(encode(hello));
    if (message.type === 'bands')
      socket.write(encode({ type: 'bands_ok', bandVersion: '7', generation: 'tv-0001' }));
    if (message.type === 'search') {
      socket.write(
        encode({
          type: 'results',
          hits: [{ objectId: 'a', score: 0.9, rank: 1 }],
          traceDigest: 'sha256:deadbeef',
        }),
      );
    }
  };
}

describe('the retrieval client refuses rather than answering short', () => {
  it('accepts a well-behaved engine and returns its ranking', async () => {
    const client = new RetrievalClient({ socketPath: engine(wellBehaved()) });
    expect(await client.pushBands(BITMAPS)).toEqual({ ok: true });
    const outcome = await client.search({
      organizationId: BITMAPS.organizationId,
      bandVersion: '7',
      generation: 'tv-0001',
      ceiling: 'internal',
      allow: [],
      deny: [],
      query: 'supplier qualification',
      k: 10,
    });
    expect(outcome.status).toBe('ranked');
  });

  it('refuses an engine that resolved a non-local embedder', async () => {
    const path = engine(
      wellBehaved({
        ...HELLO_OK,
        embedder: { identity: 'openai:text-embedding-3-small', local: false },
      }),
    );
    const outcome = await new RetrievalClient({ socketPath: path }).pushBands(BITMAPS);
    expect(outcome).toMatchObject({ status: 'unavailable' });
    expect((outcome as { reason: string }).reason).toMatch(/non-local embedder/);
    expect(
      (outcome as { reason: string }).reason,
      'the refusal has to name the provider, or an operator cannot tell which control fired',
    ).toMatch(/openai/);
  });

  it('refuses an engine speaking a different protocol', async () => {
    const path = engine(wellBehaved({ ...HELLO_OK, protocol: RETRIEVAL_PROTOCOL_VERSION + 1 }));
    expect(await new RetrievalClient({ socketPath: path }).pushBands(BITMAPS)).toMatchObject({
      status: 'unavailable',
    });
  });

  it('refuses bands when the engine has moved generation, and asks for a rebuild', async () => {
    const path = engine(wellBehaved({ ...HELLO_OK, generation: 'tv-0002' }));
    const outcome = await new RetrievalClient({ socketPath: path }).pushBands(BITMAPS);
    expect(outcome).toMatchObject({ status: 'unavailable', rebuildBands: true });
  });

  it('is unavailable when nothing is listening', async () => {
    const client = new RetrievalClient({ socketPath: '/nonexistent/kf-retrieval.sock' });
    expect(await client.pushBands(BITMAPS)).toMatchObject({ status: 'unavailable' });
  });

  it('is unavailable when the engine accepts and then says nothing', async () => {
    const path = engine(() => {
      /* Silence. The worst failure, because it looks like work. */
    });
    const client = new RetrievalClient({ socketPath: path, timeoutMs: 120 });
    const outcome = await client.pushBands(BITMAPS);
    expect(outcome).toMatchObject({ status: 'unavailable' });
    expect((outcome as { reason: string }).reason).toMatch(/did not answer within/);
  });

  it('is unavailable when the engine hangs up part-way through answering', async () => {
    const path = engine((socket, line) => {
      const message: { type: string } = JSON.parse(line);
      if (message.type === 'hello') socket.write(encode(HELLO_OK));
      if (message.type === 'bands') socket.destroy();
    });
    expect(
      await new RetrievalClient({ socketPath: path, timeoutMs: 500 }).pushBands(BITMAPS),
    ).toMatchObject({ status: 'unavailable' });
  });

  it('is unavailable when the engine sends something that is not a message', async () => {
    const path = engine((socket) => socket.write('not json at all\n'));
    expect(
      await new RetrievalClient({ socketPath: path, timeoutMs: 500 }).pushBands(BITMAPS),
    ).toMatchObject({ status: 'unavailable' });
  });

  it('asks for a rebuild on a stale-band refusal, and not on an internal one', async () => {
    const refusing = (code: string) =>
      engine((socket, line) => {
        const message: { type: string } = JSON.parse(line);
        if (message.type === 'search')
          socket.write(encode({ type: 'error', code, detail: code } as ServerMessage));
      });
    const ask = async (code: string) =>
      new RetrievalClient({ socketPath: refusing(code), timeoutMs: 500 }).search({
        organizationId: BITMAPS.organizationId,
        bandVersion: '7',
        generation: 'tv-0001',
        ceiling: 'public',
        allow: [],
        deny: [],
        query: 'x',
        k: 5,
      });

    expect(await ask('bands_stale')).toMatchObject({ status: 'unavailable', rebuildBands: true });
    active?.server.close();
    expect(await ask('internal')).toMatchObject({ status: 'unavailable', rebuildBands: false });
  });

  it('never carries hits on any outcome that is not a ranking', async () => {
    const path = engine((socket, line) => {
      const message: { type: string } = JSON.parse(line);
      // A hostile engine: results AND an error, in that order.
      if (message.type === 'search') {
        socket.write(encode({ type: 'error', code: 'internal', detail: 'fell over' }));
      }
    });
    const outcome = await new RetrievalClient({ socketPath: path, timeoutMs: 500 }).search({
      organizationId: BITMAPS.organizationId,
      bandVersion: '7',
      generation: 'tv-0001',
      ceiling: 'restricted',
      allow: [],
      deny: [],
      query: 'x',
      k: 5,
    });
    expect(outcome.status).toBe('unavailable');
    expect('hits' in outcome).toBe(false);
  });

  it('turns an unavailable outcome into a withholding entry that states its basis', async () => {
    const client = new RetrievalClient({ socketPath: '/nonexistent/kf.sock' });
    const outcome = await client.pushBands(BITMAPS);
    const entry = withheldForUnavailable(outcome as never);
    expect(entry?.reasonClass).toBe('semantic_ranking_unavailable');
    expect(
      entry?.reason,
      'a ledger entry carries its basis; a boolean carries only itself',
    ).toBeTruthy();
  });
});

describe('the bitmap wire encoding', () => {
  it('round-trips every slot, including the ones past a byte boundary', () => {
    const bits = new Uint8Array(19);
    for (const slot of [0, 7, 8, 15, 16, 18]) bits[slot] = 1;
    expect([...unpackBits(packBits(bits), 19)]).toEqual([...bits]);
  });

  it('reads a truncated bitmap as closed rather than open', () => {
    // A short encoding means the sender knew about fewer slots. Every slot it did not speak to
    // must read as unauthorized: KF-SAS-RQ-215's pad-with-false, at the encoding layer.
    const shorter = packBits(Uint8Array.from([1, 1]));
    expect([...unpackBits(shorter, 6)]).toEqual([1, 1, 0, 0, 0, 0]);
  });
});
