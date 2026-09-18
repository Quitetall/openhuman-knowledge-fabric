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
  type Band,
  type BandsRequest,
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
    }
  | { readonly status: 'unavailable'; readonly reason: string; readonly rebuildBands: boolean };

export interface RetrievalClientOptions {
  readonly socketPath: string;
  /** A query that has not answered by now has failed. Silence is not a slower success. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

function unavailable(reason: string, rebuildBands = false): RetrievalOutcome {
  return { status: 'unavailable', reason, rebuildBands };
}

/**
 * One request, one connection, one answer.
 *
 * Deliberately not a pooled long-lived connection. A pooled socket carries state between callers,
 * and the state this protocol carries — which bands the engine believes it holds — is exactly the
 * state that must not be inherited by the next caller. The cost is a unix-socket connect per
 * query, which is microseconds.
 */
async function exchange(
  options: RetrievalClientOptions,
  messages: readonly (BandsRequest | SearchRequest | { type: 'hello'; protocol: number })[],
): Promise<ServerMessage[] | { readonly failure: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const received: ServerMessage[] = [];
    let buffer = '';

    const finish = (value: ServerMessage[] | { readonly failure: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(
      () => finish({ failure: `engine did not answer within ${timeoutMs}ms` }),
      timeoutMs,
    );

    let socket: Socket;
    try {
      socket = connect(options.socketPath);
    } catch (error) {
      clearTimeout(timer);
      resolve({ failure: `could not reach the engine: ${String(error)}` });
      return;
    }

    socket.on('error', (error) => finish({ failure: `socket failed: ${error.message}` }));
    socket.on('close', () => {
      if (received.length < messages.length) {
        finish({ failure: 'engine closed the connection before answering' });
      }
    });

    socket.on('connect', () => {
      for (const message of messages) socket.write(encode(message));
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== '') {
          try {
            received.push(decodeServer(line));
          } catch {
            finish({ failure: 'engine sent a line that is not a message' });
            return;
          }
        }
        if (received.length === messages.length) {
          finish(received);
          return;
        }
        newline = buffer.indexOf('\n');
      }
    });
  });
}

export class RetrievalClient {
  constructor(private readonly options: RetrievalClientOptions) {}

  /**
   * Push band membership, and learn whether the engine is usable at all.
   *
   * The handshake and the band push travel together because neither is useful alone: an engine
   * that speaks the protocol but embeds through a third party must not be used, and bands pushed
   * to an engine whose slot ordering has moved describe a different index.
   */
  async pushBands(bitmaps: BandBitmaps): Promise<RetrievalOutcome | { readonly ok: true }> {
    const bands = Object.fromEntries(
      (Object.keys(bitmaps.bands) as Band[]).map((band) => [band, packBits(bitmaps.bands[band])]),
    ) as Record<Band, string>;

    const answers = await exchange(this.options, [
      { type: 'hello', protocol: RETRIEVAL_PROTOCOL_VERSION },
      {
        type: 'bands',
        organizationId: bitmaps.organizationId,
        bandVersion: bitmaps.bandVersion.toString(),
        generation: bitmaps.generation,
        slotCount: bitmaps.slotCount,
        bands,
        unresolved: packBits(bitmaps.unresolved),
      },
    ]);

    if ('failure' in answers) return unavailable(answers.failure);

    const [hello, accepted] = answers;
    if (hello?.type === 'error')
      return unavailable(`engine refused the handshake: ${hello.detail}`);
    if (hello?.type !== 'hello_ok') return unavailable('engine did not complete the handshake');
    if (hello.protocol !== RETRIEVAL_PROTOCOL_VERSION) {
      return unavailable(
        `engine speaks protocol ${hello.protocol}, this Fabric speaks ${RETRIEVAL_PROTOCOL_VERSION}`,
      );
    }
    if (!hello.embedder.local) {
      // KF-SAS-RQ-218. Refused rather than warned: a warning is a control that did not act.
      return unavailable(
        `engine resolved a non-local embedder (${hello.embedder.identity}); controlled content ` +
          'must not leave the host to be embedded',
      );
    }
    if (hello.generation !== bitmaps.generation) {
      return unavailable(
        `engine is at generation ${hello.generation}, bitmaps were built for ${bitmaps.generation}`,
        true,
      );
    }
    if (accepted?.type === 'error')
      return unavailable(`engine refused the bands: ${accepted.detail}`);
    if (accepted?.type !== 'bands_ok') return unavailable('engine did not accept the bands');

    return { ok: true };
  }

  async search(request: Omit<SearchRequest, 'type'>): Promise<RetrievalOutcome> {
    const answers = await exchange(this.options, [{ type: 'search', ...request }]);
    if ('failure' in answers) return unavailable(answers.failure);

    const [answer] = answers;
    if (answer?.type === 'error') {
      // An engine that has lost the bands, or moved generation, is not broken — it is out of
      // step, and the caller can fix it by rebuilding. Distinguished so a supervisor can act.
      const rebuild =
        answer.code === 'bands_unknown' ||
        answer.code === 'bands_stale' ||
        answer.code === 'generation_mismatch';
      return unavailable(`engine refused: ${answer.code} — ${answer.detail}`, rebuild);
    }
    if (answer?.type !== 'results') return unavailable('engine did not return a ranking');

    return { status: 'ranked', hits: answer.hits, traceDigest: answer.traceDigest };
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
