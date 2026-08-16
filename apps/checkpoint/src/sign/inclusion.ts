import { inclusionProof, leafHash, verifyInclusion, type InclusionProof } from '../merkle.js';
import type { AuditEntry, CheckpointFormat } from './contracts.js';
import { leafBytes } from './chain.js';
import { auditSequence } from './sequences.js';

/**
 * Prove one event was in a signed checkpoint.
 *
 * This is what an auditor actually uses: "show me that THIS approval was in the history you
 * signed on that date" — answerable with the event, a short path, and the signature, without
 * handing over the whole log.
 */
export function proveInclusion(
  entries: readonly AuditEntry[],
  seq: string | bigint | number,
  formatVersion: CheckpointFormat,
): { proof: InclusionProof; leaf: Buffer } {
  const wanted = auditSequence(seq);
  const index = entries.findIndex((e) => auditSequence(e.seq) === wanted);
  if (index < 0) throw new RangeError(`seq ${wanted} is not in this checkpoint range`);
  const leaves = entries.map((e) => leafHash(leafBytes(e, formatVersion)));
  return { proof: inclusionProof(leaves, index), leaf: leaves[index]! };
}

export function checkInclusion(
  leaf: Buffer,
  proof: InclusionProof,
  merkleRootHex: string,
): boolean {
  return verifyInclusion(leaf, proof, Buffer.from(merkleRootHex, 'hex'));
}
