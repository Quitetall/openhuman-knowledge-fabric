/**
 * The wire contract between the Fabric and a retrieval engine (§64A).
 *
 * This file is the compatibility boundary, and that is its whole purpose. The engine ships on its
 * own cadence — new rankers, new fusion, a different index format, the compressed-index work —
 * and none of it requires a Fabric deployment. What requires coordination is exactly what appears
 * below: a version, a handful of message shapes, and the generation semantics. The Fabric pins a
 * PROTOCOL version, never an engine version, because pinning the engine would put its release
 * schedule inside ours, which is the thing this seam exists to prevent.
 *
 * Newline-delimited JSON over a unix domain socket. Not because JSON is fast — it is not — but
 * because this channel carries a few hundred bytes per query and one bitmap push per
 * reclassification, and being able to read a capture with your eyes is worth more here than
 * throughput. The bitmaps are base64; at a million vectors a band is about 167 KB encoded, pushed
 * when a classification changes rather than per query.
 */

/**
 * Incremented for a BREAKING change only. Adding an optional field to a message, or adding a new
 * message, is additive and does not move this — an engine that does not know a new optional field
 * ignores it, and one that does not know a new message refuses it by name rather than by silence.
 */
export const RETRIEVAL_PROTOCOL_VERSION = 1;

export const BANDS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Band = (typeof BANDS)[number];

/** Opens the connection. The Fabric states what it speaks; the engine answers or is not used. */
export interface HelloRequest {
  readonly type: 'hello';
  readonly protocol: number;
}

/**
 * What the engine must declare before it is trusted with anything.
 *
 * `embedder.local` is the load-bearing field and the reason this handshake exists at all.
 * KF-SAS-RQ-218 forbids controlled content leaving the host to be embedded, and record text
 * necessarily transits to the engine to become a vector (§64A). The engine enforces this on its
 * own side — it is the only party that knows which provider actually resolved — and the Fabric
 * refuses to proceed without hearing it say so. A control on one of two paths gets missed on the
 * other.
 */
export interface HelloResponse {
  readonly type: 'hello_ok';
  readonly protocol: number;
  readonly engine: string;
  readonly generation: string;
  readonly slotCount: number;
  readonly embedder: {
    readonly identity: string;
    readonly local: boolean;
  };
}

/**
 * Push band membership. Sent when the band version moves, not per query.
 *
 * The bitmaps are identical for every caller in the organization — that is what makes them
 * cacheable and what makes this a push rather than a per-query payload. The engine holds them in
 * memory only (KF-SAS-RQ-223): written to disk they become a durable copy of an authorization
 * input, which is the category §64A exists to eliminate.
 */
export interface BandsRequest {
  readonly type: 'bands';
  readonly organizationId: string;
  readonly bandVersion: string;
  readonly generation: string;
  readonly slotCount: number;
  /** base64, one bit per slot, little-endian within each byte. */
  readonly bands: Readonly<Record<Band, string>>;
  /** Slots whose identifier resolved to no record. Never scorable at any ceiling. */
  readonly unresolved: string;
}

export interface BandsAccepted {
  readonly type: 'bands_ok';
  readonly bandVersion: string;
  readonly generation: string;
}

/**
 * Ask for a ranking.
 *
 * Carries the query text, because the engine holds the embedder and a vector has to be made from
 * text. It carries no record text: KF-SAS-RQ-213. The `allow` and `deny` lists are the per-object
 * half of the caller's coverage — small, explicit, and applied on top of the band mask.
 */
export interface SearchRequest {
  readonly type: 'search';
  readonly organizationId: string;
  readonly bandVersion: string;
  readonly generation: string;
  readonly ceiling: Band;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly query: string;
  readonly k: number;
}

export interface SearchResults {
  readonly type: 'results';
  readonly hits: readonly {
    readonly objectId: string;
    readonly score: number;
    readonly rank: number;
  }[];
  /** Digest of the engine's own trace. The trace stays disposable there; this is what KF records (RQ-219). */
  readonly traceDigest: string;
}

/**
 * The engine refusing.
 *
 * Every one of these produces an unavailable result on the Fabric's side. None of them produces a
 * shorter list of hits, because a caller cannot tell a short answer from a complete one and will
 * act on it as complete.
 */
export interface EngineError {
  readonly type: 'error';
  readonly code:
    | 'protocol_unsupported'
    | 'bands_unknown'
    | 'bands_stale'
    | 'generation_mismatch'
    | 'mask_longer_than_index'
    | 'embedder_unavailable'
    | 'internal';
  readonly detail: string;
}

export type ClientMessage = HelloRequest | BandsRequest | SearchRequest;
export type ServerMessage = HelloResponse | BandsAccepted | SearchResults | EngineError;

/** One message, one line. A message containing a newline would be two messages. */
export function encode(message: ClientMessage | ServerMessage): string {
  const line = JSON.stringify(message);
  if (line.includes('\n')) throw new Error('a framed message may not contain a newline');
  return `${line}\n`;
}

export function decodeServer(line: string): ServerMessage {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
    throw new Error('server message has no type');
  }
  return parsed as ServerMessage;
}

/** A bitmap as the wire carries it: one bit per slot, little-endian within each byte. */
export function packBits(bits: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === 1) bytes[i >>> 3] = (bytes[i >>> 3] ?? 0) | (1 << (i & 7));
  }
  return Buffer.from(bytes).toString('base64');
}

export function unpackBits(encoded: string, slotCount: number): Uint8Array {
  const bytes = Buffer.from(encoded, 'base64');
  const bits = new Uint8Array(slotCount);
  for (let i = 0; i < slotCount; i += 1) {
    bits[i] = ((bytes[i >>> 3] ?? 0) >>> (i & 7)) & 1;
  }
  return bits;
}
