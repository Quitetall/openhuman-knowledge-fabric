import { canonicalize } from '@kf/canonicalization';

import type { Checkpoint } from './contracts.js';
import { auditSequence, legacyWireNumber } from './sequences.js';

const CANONICAL_ED25519_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

export function canonicalEd25519Signature(value: string): Buffer | undefined {
  if (!CANONICAL_ED25519_SIGNATURE.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== value) return undefined;
  return decoded;
}

export function checkpointSignaturePayload(checkpoint: Checkpoint): Buffer {
  const exact = checkpoint.formatVersion === 'kf.audit-checkpoint.v3';
  const common = {
    from_seq: exact ? auditSequence(checkpoint.fromSeq) : legacyWireNumber(checkpoint.fromSeq),
    to_seq: exact ? auditSequence(checkpoint.toSeq) : legacyWireNumber(checkpoint.toSeq),
    leaf_count: exact
      ? auditSequence(checkpoint.leafCount)
      : legacyWireNumber(checkpoint.leafCount),
    merkle_root: checkpoint.merkleRoot,
    signing_key_id: checkpoint.signingKeyId,
  };
  return Buffer.from(
    canonicalize(
      checkpoint.formatVersion === 'kf.audit-checkpoint.v1'
        ? common
        : { ...common, format_version: checkpoint.formatVersion },
    ),
    'utf8',
  );
}
