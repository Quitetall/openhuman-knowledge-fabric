/**
 * The Fabric's side of the retrieval socket — fail closed, at every branch (§64A, RQ-216).
 *
 * One rule governs this file and it is worth stating before the code: **there is no partial
 * answer**. Every failure — a dead socket, a timeout, a protocol the engine does not speak, a
 * band version it has not been told about, a non-local embedder, a malformed line — produces
 * `unavailable`. None produces a shorter list of hits.
 *
 * The reason is not tidiness. A caller who receives four hits cannot tell whether four is the
 * answer or whether the engine fell over after four, and an agent given a short list acts on it
 * as complete. A refusal is legible; a quiet truncation is a wrong answer that looks like a right
 * one. This is the same failure as a recall collapse, wearing different clothes.
 */

import { connect, type Socket } from 'node:net';
import {
  decodeServer,
  encode,
  packBits,
  RETRIEVAL_PROTOCOL_VERSION,
  VECTORS_ONLY_WRITE,
  type Band,
  type ClientMessage,
  type HelloResponse,
  type SearchRequest,
  type ServerMessage,
} from './protocol.js';
import type { BandBitmaps } from './index.js';

export interface RetrievalHit {
  readonly objectId: string;
  readonly score: number;
  readonly rank: number;
}

/**
 * What a retrieval attempt produced.
 *
 * `unavailable` is a first-class outcome rather than a thrown error, because it is an ordinary
 * thing for the Fabric to have to say to a caller, and because forcing it through a catch invites
 * someone to swallow it. The `reason` is for the withholding ledger: a ledger entry carries its
 * basis, where a boolean would carry only its own truth.
 */
export type RetrievalOutcome =
  | {
      readonly status: 'ranked';
      readonly hits: readonly RetrievalHit[];
      readonly traceDigest: string;
      /** The ranking that produced the hits, as the engine names it, or `engine:<engine>` (RQ-224). */
      readonly ranking: string;
    }
  | Unavailable;

export interface Unavailable {
  readonly status: 'unavailable';
  readonly reason: string;
  readonly rebuildBands: boolean;
}

export interface RetrievalClientOptions {
  readonly socketPath: string;
  /** A query that has not answered by now has failed. Silence is not a slower success. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

function unavailable(reason: string, rebuildBands = false): Unavailable {
  return { status: 'unavailable', reason, rebuildBands };
}

type Answer = ServerMessage | { readonly failure: string };

/**
 * One connection, asked one message at a time.
 *
 * Deliberately not a pooled long-lived connection. A pooled socket carries state between callers,
 * and the state this protocol carries — which bands the engine believes it holds — is exactly the
 * state that must not be inherited by the next caller. The cost is a unix-socket connect per
 * query, which is microseconds.
 *
 * And deliberately conversational rather than pipelined: the handshake is answered and CHECKED
 * before the next message is written. A pipelined `hello` + `search` would already have handed the
 * query text — or, on the write path, record text — to an engine whose embedder turns out to be
 * remote by the time the Fabric reads the answer that says so.
 */
class Session {
  private buffer = '';
  private readonly lines: string[] = [];
  private waiter: ((answer: Answer) => void) | undefined;
  private broken: string | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly timer: NodeJS.Timeout,
  ) {
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim() !== '') this.lines.push(line);
        newline = this.buffer.indexOf('\n');
      }
      this.deliver();
    });
    socket.on('error', (error) => this.fail(`socket failed: ${error.message}`));
    socket.on('close', () => this.fail('engine closed the connection before answering'));
  }

  static open(options: RetrievalClientOptions): Promise<Session | { readonly failure: string }> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      let socket: Socket;
      let session: Session | undefined;
      const timer = setTimeout(() => {
        const failure = `engine did not answer within ${timeoutMs}ms`;
        if (session === undefined) {
          socket?.destroy();
          resolve({ failure });
        } else {
          session.fail(failure);
        }
      }, timeoutMs);
      try {
        socket = connect(options.socketPath);
      } catch (error) {
        clearTimeout(timer);
        resolve({ failure: `could not reach the engine: ${String(error)}` });
        return;
      }
      const early = (error: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ failure: `socket failed: ${error.message}` });
      };
      socket.once('error', early);
      socket.once('connect', () => {
        socket.off('error', early);
        session = new Session(socket, timer);
        resolve(session);
      });
    });
  }

  ask(message: ClientMessage): Promise<Answer> {
    if (this.broken !== undefined) return Promise.resolve({ failure: this.broken });
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.socket.write(encode(message));
      this.deliver();
    });
  }

  close(): void {
    clearTimeout(this.timer);
    this.broken ??= 'session closed';
    this.socket.destroy();
  }

  private deliver(): void {
    const waiter = this.waiter;
    if (waiter === undefined) return;
    const line = this.lines.shift();
    if (line === undefined) {
      if (this.broken !== undefined) {
        this.waiter = undefined;
        waiter({ failure: this.broken });
      }
      return;
    }
    this.waiter = undefined;
    try {
      waiter(decodeServer(line));
    } catch {
      this.fail('engine sent a line that is not a message');
      waiter({ failure: 'engine sent a line that is not a message' });
    }
  }

  private fail(reason: string): void {
    if (this.broken === undefined) this.broken = reason;
    clearTimeout(this.timer);
    this.socket.destroy();
    this.deliver();
  }
}

/** What the handshake establishes, for the path that asked for it. */
interface Handshake {
  readonly session: Session;
  readonly hello: HelloResponse;
}

export class RetrievalClient {
  /**
   * The embedder identity this client first heard (KF-SAS-RQ-218).
   *
   * Registered once: a later handshake naming a different identity is refused, not adopted. The
   * vectors already in the index were made by the first embedder, and a query embedded by a
   * second one is scored against a space it does not share — and an identity that changes under
   * a running process is exactly how a remote provider replaces a local one without anybody
   * deciding it should. The composition root builds one client per engine, so this is the
   * process's binding.
   */
  private pinnedEmbedder: string | undefined;

  constructor(private readonly options: RetrievalClientOptions) {}

  /** The pinned embedder identity, once a handshake has succeeded. */
  get embedderIdentity(): string | undefined {
    return this.pinnedEmbedder;
  }

  /**
   * Open a connection and check the engine before anything else is sent.
   *
   * Every refusal here happens before the caller's payload leaves the process: a wrong protocol,
   * a non-local embedder, an embedder that is not the one first registered, or — for a path that
   * needs one — a missing capability.
   */
  private async handshake(requires?: typeof VECTORS_ONLY_WRITE): Promise<Handshake | Unavailable> {
    const session = await Session.open(this.options);
    if ('failure' in session) return unavailable(session.failure);

    const hello = await session.ask({ type: 'hello', protocol: RETRIEVAL_PROTOCOL_VERSION });
    const refuse = (reason: string): Unavailable => {
      session.close();
      return unavailable(reason);
    };
    if ('failure' in hello) return refuse(hello.failure);
    if (hello.type === 'error') return refuse(`engine refused the handshake: ${hello.detail}`);
    if (hello.type !== 'hello_ok') return refuse('engine did not complete the handshake');
    if (hello.protocol !== RETRIEVAL_PROTOCOL_VERSION) {
      return refuse(
        `engine speaks protocol ${hello.protocol}, this Fabric speaks ${RETRIEVAL_PROTOCOL_VERSION}`,
      );
    }
    if (hello.embedder?.local !== true) {
      // KF-SAS-RQ-218. Refused rather than warned: a warning is a control that did not act.
      return refuse(
        `engine resolved a non-local embedder (${String(hello.embedder?.identity)}); controlled ` +
          'content must not leave the host to be embedded',
      );
    }
    const identity = hello.embedder.identity;
    if (typeof identity !== 'string' || identity === '') {
      return refuse('engine did not name its embedder');
    }
    if (this.pinnedEmbedder !== undefined && this.pinnedEmbedder !== identity) {
      return refuse(
        `engine embedder changed from ${this.pinnedEmbedder} to ${identity}; the embedder binding ` +
          'is registered once and not replaced while the process runs',
      );
    }
    if (requires !== undefined && !(hello.capabilities ?? []).includes(requires)) {
      // KF-SAS-RQ-225. Without the vectors-only path, the only write path an engine built to
      // remember things has is the one that remembers the text.
      return refuse(
        `engine does not declare ${requires}; record text is sent only to a path that persists none`,
      );
    }
    this.pinnedEmbedder = identity;
    return { session, hello };
  }

  /**
   * Check the engine without sending it anything else — the startup handshake.
   *
   * A composition root that will write record text calls this with `vectors_only_write` before
   * it starts, and refuses to start on anything but `ok`.
   */
  async probe(
    requires?: typeof VECTORS_ONLY_WRITE,
  ): Promise<Unavailable | { readonly ok: true; readonly hello: HelloResponse }> {
    const opened = await this.handshake(requires);
    if ('status' in opened) return opened;
    opened.session.close();
    return { ok: true, hello: opened.hello };
  }

  /**
   * The engine's slot ordering, so bitmaps can be built against it.
   */
  async slots(): Promise<
    | Unavailable
    | {
        readonly status: 'slots';
        readonly generation: string;
        readonly objectIds: readonly string[];
      }
  > {
    const opened = await this.handshake();
    if ('status' in opened) return opened;
    const { session } = opened;
    try {
      const answer = await session.ask({ type: 'slots' });
      if ('failure' in answer) return unavailable(answer.failure);
      if (answer.type === 'error')
        return unavailable(`engine refused: ${answer.code} — ${answer.detail}`);
      if (answer.type !== 'slots_ok' || !Array.isArray(answer.objectIds)) {
        return unavailable('engine did not return its slot ordering');
      }
      return { status: 'slots', generation: answer.generation, objectIds: answer.objectIds };
    } finally {
      session.close();
    }
  }

  /**
   * Push band membership, and learn whether the engine is usable at all.
   *
   * The handshake and the band push travel together because neither is useful alone: an engine
   * that speaks the protocol but embeds through a third party must not be used, and bands pushed
   * to an engine whose slot ordering has moved describe a different index.
   */
  async pushBands(bitmaps: BandBitmaps): Promise<Unavailable | { readonly ok: true }> {
    const bands = Object.fromEntries(
      (Object.keys(bitmaps.bands) as Band[]).map((band) => [band, packBits(bitmaps.bands[band])]),
    ) as Record<Band, string>;

    const opened = await this.handshake();
    if ('status' in opened) return opened;
    const { session, hello } = opened;
    try {
      if (hello.generation !== bitmaps.generation) {
        return unavailable(
          `engine is at generation ${hello.generation}, bitmaps were built for ${bitmaps.generation}`,
          true,
        );
      }
      const accepted = await session.ask({
        type: 'bands',
        organizationId: bitmaps.organizationId,
        bandVersion: bitmaps.bandVersion,
        generation: bitmaps.generation,
        slotCount: bitmaps.slotCount,
        bands,
        unresolved: packBits(bitmaps.unresolved),
      });
      if ('failure' in accepted) return unavailable(accepted.failure);
      if (accepted.type === 'error')
        return unavailable(`engine refused the bands: ${accepted.detail}`);
      if (accepted.type !== 'bands_ok') return unavailable('engine did not accept the bands');
      return { ok: true };
    } finally {
      session.close();
    }
  }

  async search(request: Omit<SearchRequest, 'type'>): Promise<RetrievalOutcome> {
    const opened = await this.handshake();
    if ('status' in opened) return opened;
    const { session, hello } = opened;
    try {
      const answer = await session.ask({ type: 'search', ...request });
      if ('failure' in answer) return unavailable(answer.failure);
      if (answer.type === 'error') {
        // An engine that has lost the bands, or moved generation, is not broken — it is out of
        // step, and the caller can fix it by rebuilding. Distinguished so a supervisor can act.
        const rebuild =
          answer.code === 'bands_unknown' ||
          answer.code === 'bands_stale' ||
          answer.code === 'generation_mismatch';
        return unavailable(`engine refused: ${answer.code} — ${answer.detail}`, rebuild);
      }
      if (answer.type !== 'results' || !Array.isArray(answer.hits)) {
        return unavailable('engine did not return a ranking');
      }
      if (typeof answer.traceDigest !== 'string' || answer.traceDigest === '') {
        // RQ-219: what was disclosed is recorded as the trace's digest. A ranking with no digest
        // is one whose disclosure cannot be recorded, so it is not served.
        return unavailable('engine returned a ranking with no trace digest');
      }
      return {
        status: 'ranked',
        hits: answer.hits,
        traceDigest: answer.traceDigest,
        ranking:
          typeof answer.ranking === 'string' && answer.ranking !== ''
            ? answer.ranking
            : `engine:${hello.engine}`,
      };
    } finally {
      session.close();
    }
  }

  /**
   * Hand one record's text to the engine to be embedded, through the path that keeps no text
   * (KF-SAS-RQ-225). Refused before the text is written unless this connection's handshake
   * declared `vectors_only_write` from a local, pinned embedder.
   */
  async writeVector(request: {
    readonly organizationId: string;
    readonly objectId: string;
    readonly text: string;
  }): Promise<Unavailable | { readonly ok: true; readonly generation: string }> {
    const opened = await this.handshake(VECTORS_ONLY_WRITE);
    if ('status' in opened) return opened;
    const { session } = opened;
    try {
      const answer = await session.ask({ type: 'write_vector', ...request });
      if ('failure' in answer) return unavailable(answer.failure);
      if (answer.type === 'error')
        return unavailable(`engine refused: ${answer.code} — ${answer.detail}`);
      if (answer.type !== 'write_vector_ok' || answer.objectId !== request.objectId) {
        return unavailable('engine did not acknowledge the vector');
      }
      return { ok: true, generation: answer.generation };
    } finally {
      session.close();
    }
  }
}

/**
 * The entry for a withholding ledger when semantic ranking did not happen (§63, RQ-216).
 *
 * A ledger entry rather than a flag, because the ledger's whole point is that an omission states
 * its basis. "Semantic ranking unavailable" with no reason is only marginally better than saying
 * nothing.
 */
export function withheldForUnavailable(outcome: RetrievalOutcome):
  | {
      readonly reasonClass: string;
      readonly reason: string;
    }
  | undefined {
  if (outcome.status !== 'unavailable') return undefined;
  return { reasonClass: 'semantic_ranking_unavailable', reason: outcome.reason };
}
