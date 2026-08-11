/**
 * Audit checkpoint construction and signing.
 *
 * The hash chain already makes a retroactive edit detectable BY RECOMPUTATION — but only to
 * someone who has an older copy to compare against. A checkpoint removes that dependency: it
 * signs a Merkle root over a range of audit events with a key the API cannot reach, so
 * anyone holding the signature can tell whether history changed, without trusting the
 * database, the application, or whoever administers them.
 *
 * That is the whole point of running this as a separate process. A compromised API can forge
 * records; it cannot forge a checkpoint saying those records were always there.
 */

import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { canonicalize } from '@kf/canonicalization';
import {
  inclusionProof,
  leafHash,
  merkleRoot,
  verifyInclusion,
  type InclusionProof,
} from './merkle.js';

/** One audit event, reduced to the fields a checkpoint commits to. */
export interface AuditEntry {
  readonly seq: number;
  readonly id: string;
  readonly action_id: string;
  readonly actor_id: string;
  readonly action_type: string;
  readonly recorded_at: string;
  readonly prev_digest: string;
  readonly digest: string;
}

export interface Checkpoint {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly merkleRoot: string;
  readonly signature: string;
  readonly signingKeyId: string;
  readonly leafCount: number;
}

/**
 * The bytes a leaf commits to.
 *
 * The event's own `digest` alone would be enough to detect a changed event, but not a
 * REORDERED or REPLACED one — two events could swap sequence numbers and every digest would
 * still verify. Including `seq` binds each event to its position.
 */
export function leafBytes(entry: AuditEntry): Buffer {
  return Buffer.from(
    canonicalize({
      seq: entry.seq,
      id: entry.id,
      action_id: entry.action_id,
      actor_id: entry.actor_id,
      action_type: entry.action_type,
      recorded_at: entry.recorded_at,
      prev_digest: entry.prev_digest,
      digest: entry.digest,
    }),
    'utf8',
  );
}

/**
 * Walk the chain and report the first place it breaks.
 *
 * Run before signing: a checkpoint over a broken chain would attest to tampering rather
 * than against it.
 */
export function verifyChain(
  entries: readonly AuditEntry[],
  expectedFirstPrev: string,
): { ok: true } | { ok: false; atSeq: number; detail: string } {
  let prev = expectedFirstPrev;
  for (const e of entries) {
    if (e.prev_digest !== prev) {
      return {
        ok: false,
        atSeq: e.seq,
        detail: `prev_digest is ${e.prev_digest}, expected ${prev}`,
      };
    }
    prev = e.digest;
  }
  return { ok: true };
}

export interface SigningKey {
  readonly id: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/** Ed25519: small keys, small signatures, no parameter choices to get wrong. */
export function generateSigningKey(id: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { id, privateKey, publicKey };
}

export function loadSigningKey(id: string, privatePem: string): SigningKey {
  const privateKey = createPrivateKey(privatePem);
  return { id, privateKey, publicKey: createPublicKey(privateKey) };
}

/**
 * Build and sign a checkpoint over `entries`.
 *
 * The signature covers the root AND the range, not just the root. A bare root signature
 * could be replayed against a different range that happened to produce the same tree — and
 * more practically, it would not say WHAT was covered, which is most of what a checkpoint
 * is for.
 */
export function buildCheckpoint(
  entries: readonly AuditEntry[],
  key: SigningKey,
  expectedFirstPrev: string,
): Checkpoint {
  if (entries.length === 0) {
    throw new Error('refusing to sign an empty checkpoint: there is nothing to attest to');
  }

  const chain = verifyChain(entries, expectedFirstPrev);
  if (!chain.ok) {
    throw new Error(
      `refusing to sign: the audit chain is already broken at seq ${chain.atSeq} — ${chain.detail}`,
    );
  }

  const leaves = entries.map((e) => leafHash(leafBytes(e)));
  const root = merkleRoot(leaves);
  const fromSeq = entries[0]!.seq;
  const toSeq = entries[entries.length - 1]!.seq;

  const payload = Buffer.from(
    canonicalize({
      from_seq: fromSeq,
      to_seq: toSeq,
      leaf_count: entries.length,
      merkle_root: root.toString('hex'),
      signing_key_id: key.id,
    }),
    'utf8',
  );

  return {
    fromSeq,
    toSeq,
    merkleRoot: root.toString('hex'),
    signature: edSign(null, payload, key.privateKey).toString('base64'),
    signingKeyId: key.id,
    leafCount: entries.length,
  };
}

export function verifyCheckpoint(checkpoint: Checkpoint, publicKey: KeyObject): boolean {
  const payload = Buffer.from(
    canonicalize({
      from_seq: checkpoint.fromSeq,
      to_seq: checkpoint.toSeq,
      leaf_count: checkpoint.leafCount,
      merkle_root: checkpoint.merkleRoot,
      signing_key_id: checkpoint.signingKeyId,
    }),
    'utf8',
  );
  return edVerify(null, payload, publicKey, Buffer.from(checkpoint.signature, 'base64'));
}

/**
 * Prove one event was in a signed checkpoint.
 *
 * This is what an auditor actually uses: "show me that THIS approval was in the history you
 * signed on that date" — answerable with the event, a short path, and the signature, without
 * handing over the whole log.
 */
export function proveInclusion(
  entries: readonly AuditEntry[],
  seq: number,
): { proof: InclusionProof; leaf: Buffer } {
  const index = entries.findIndex((e) => e.seq === seq);
  if (index < 0) throw new RangeError(`seq ${seq} is not in this checkpoint range`);
  const leaves = entries.map((e) => leafHash(leafBytes(e)));
  return { proof: inclusionProof(leaves, index), leaf: leaves[index]! };
}

export function checkInclusion(
  leaf: Buffer,
  proof: InclusionProof,
  merkleRootHex: string,
): boolean {
  return verifyInclusion(leaf, proof, Buffer.from(merkleRootHex, 'hex'));
}
