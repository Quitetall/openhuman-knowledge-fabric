/**
 * Merkle tree over audit-event commitments.
 *
 * The checkpoint process periodically builds a tree over the audit events recorded since
 * the previous checkpoint, signs the root, and stores it in immutable object storage. That
 * makes a retroactive edit detectable by anyone holding a signed root, without trusting the
 * database it was computed from.
 *
 * Domain separation follows RFC 6962 (Certificate Transparency): leaf hashes are prefixed
 * with 0x00 and interior nodes with 0x01. Without it, an interior node's preimage could be
 * presented as a leaf, letting a forged proof pass verification.
 */

import { createHash } from 'node:crypto';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export function leafHash(entry: Buffer): Buffer {
  return sha256(LEAF_PREFIX, entry);
}

export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/**
 * Root of a Merkle tree over `leaves`, which must already be leaf hashes.
 *
 * An empty tree is the hash of the empty string, per RFC 6962 — not a zero digest, so that
 * "no events" is distinguishable from "digest not computed".
 */
export function merkleRoot(leaves: readonly Buffer[]): Buffer {
  if (leaves.length === 0) return sha256();
  let level = [...leaves];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      // An odd node is promoted unchanged rather than duplicated. Duplicating it is the
      // CVE-2012-2459 malleability bug: two distinct leaf sets yield the same root.
      next.push(right === undefined ? left : nodeHash(left, right));
    }
    level = next;
  }
  return level[0]!;
}

export interface InclusionProof {
  readonly index: number;
  readonly treeSize: number;
  /** Sibling hashes from leaf to root, with the side each one sits on. */
  readonly path: readonly { readonly side: 'left' | 'right'; readonly hash: Buffer }[];
}

export function inclusionProof(leaves: readonly Buffer[], index: number): InclusionProof {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError(`index ${index} outside tree of size ${leaves.length}`);
  }
  const path: { side: 'left' | 'right'; hash: Buffer }[] = [];
  let level = [...leaves];
  let i = index;
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const siblingIndex = isRight ? i - 1 : i + 1;
    const sibling = level[siblingIndex];
    if (sibling !== undefined) {
      path.push({ side: isRight ? 'left' : 'right', hash: sibling });
    }
    const next: Buffer[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j]!;
      const right = level[j + 1];
      next.push(right === undefined ? left : nodeHash(left, right));
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return { index, treeSize: leaves.length, path };
}

export function verifyInclusion(leaf: Buffer, proof: InclusionProof, root: Buffer): boolean {
  let acc = leaf;
  for (const step of proof.path) {
    acc = step.side === 'left' ? nodeHash(step.hash, acc) : nodeHash(acc, step.hash);
  }
  return acc.equals(root);
}
