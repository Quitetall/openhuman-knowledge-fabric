import { sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';

import { leafHash, merkleRoot } from '../merkle.js';
import type { AuditEntry, Checkpoint, ExactCheckpoint, SigningKey } from './contracts.js';
import { assertStrictlyIncreasingSequences, leafBytes, verifyChain } from './chain.js';
import { assertEd25519SigningKey } from './keys.js';
import { auditSequence, isCheckpointFormat } from './sequences.js';
import { canonicalEd25519Signature, checkpointSignaturePayload } from './signature-payload.js';

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
  formatVersion?: 'kf.audit-checkpoint.v3',
): ExactCheckpoint;
export function buildCheckpoint(
  entries: readonly AuditEntry[],
  key: SigningKey,
  expectedFirstPrev: string,
  formatVersion: 'kf.audit-checkpoint.v3' = 'kf.audit-checkpoint.v3',
): ExactCheckpoint {
  if (formatVersion !== 'kf.audit-checkpoint.v3') {
    throw new Error('v1/v2 checkpoint formats are verification-only; new checkpoints use v3');
  }
  if (entries.length === 0) {
    throw new Error('refusing to sign an empty checkpoint: there is nothing to attest to');
  }
  assertEd25519SigningKey(key);

  const chain = verifyChain(entries, expectedFirstPrev);
  if (!chain.ok) {
    throw new Error(
      `refusing to sign: the audit chain is already broken at seq ${chain.atSeq} — ${chain.detail}`,
    );
  }

  assertStrictlyIncreasingSequences(entries);

  const leaves = entries.map((e) => leafHash(leafBytes(e, formatVersion)));
  const root = merkleRoot(leaves);
  const unsigned: ExactCheckpoint = {
    formatVersion,
    fromSeq: auditSequence(entries[0]!.seq),
    toSeq: auditSequence(entries[entries.length - 1]!.seq),
    leafCount: String(entries.length),
    merkleRoot: root.toString('hex'),
    signingKeyId: key.id,
    signature: '',
  };
  const payload = checkpointSignaturePayload(unsigned);

  return {
    ...unsigned,
    signature: edSign(null, payload, key.privateKey).toString('base64'),
  };
}

export function verifyCheckpoint(checkpoint: Checkpoint, publicKey: KeyObject): boolean {
  if (!isCheckpointFormat(checkpoint.formatVersion)) return false;
  const signature = canonicalEd25519Signature(checkpoint.signature);
  if (signature === undefined) return false;
  try {
    const payload = checkpointSignaturePayload(checkpoint);
    return edVerify(null, payload, publicKey, signature);
  } catch {
    return false;
  }
}
