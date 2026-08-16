import { GENESIS_DIGEST } from '@kf/canonicalization';
import { withTransaction, type Pool } from '@kf/database';

import {
  auditSequence,
  leafBytes,
  verifyChain,
  verifyCheckpoint,
  type Checkpoint,
} from '../sign.js';
import { leafHash, merkleRoot } from '../merkle.js';
import type { CheckpointRow, LedgerFinding, RawEvent, VerificationKeys } from './contracts.js';
import { lowerBound, toEntry, upperBound } from './events.js';
import { EVENT_COLUMNS, EVENT_SOURCE, JS_SAFE_INTEGER_MAX } from './sql.js';

/**
 * Recompute everything from genesis and check it against what was signed.
 *
 * This is the audit itself, not a health check: it walks the chain from the first event,
 * rebuilds each checkpoint's Merkle root from the events actually in the table, and verifies
 * each signature against the public key.
 */
export async function verifyLedger(
  pool: Pool,
  publicKeys: VerificationKeys,
): Promise<LedgerFinding[]> {
  return withTransaction(pool, async (tx) => {
    const findings: LedgerFinding[] = [];

    const events = (
      await tx.query<RawEvent>(`select ${EVENT_COLUMNS} from ${EVENT_SOURCE} order by event.seq`)
    ).map(toEntry);
    const positionedEvents = events.map((entry) => ({ entry, seq: BigInt(entry.seq) }));

    const chain = verifyChain(events, GENESIS_DIGEST);
    if (!chain.ok) {
      findings.push({ kind: 'chain_broken', detail: chain.detail, atSeq: chain.atSeq });
    }

    const checkpoints = await tx.query<CheckpointRow>(
      `select id, from_seq, to_seq, leaf_count, merkle_root, signature, signing_key_id,
              format_version
         from core.audit_checkpoint order by from_seq`,
    );

    let coveredUpTo = 0n;
    for (const cp of checkpoints) {
      const fromSeq = auditSequence(cp.from_seq);
      const toSeq = auditSequence(cp.to_seq);
      const leafCount = auditSequence(cp.leaf_count);
      const fromSeqBigint = BigInt(fromSeq);
      const toSeqBigint = BigInt(toSeq);
      const leafCountBigint = BigInt(leafCount);

      if (
        cp.format_version !== 'kf.audit-checkpoint.v3' &&
        (fromSeqBigint > JS_SAFE_INTEGER_MAX ||
          toSeqBigint > JS_SAFE_INTEGER_MAX ||
          leafCountBigint > JS_SAFE_INTEGER_MAX)
      ) {
        findings.push({
          kind: 'unsupported_legacy_range',
          detail: `checkpoint ${cp.id} uses ${cp.format_version} numeric fields outside JavaScript safe integer domain`,
          atSeq: fromSeq,
        });
        continue;
      }

      const uncoveredStart = upperBound(positionedEvents, coveredUpTo);
      const uncoveredEnd = lowerBound(positionedEvents, fromSeqBigint);
      const uncoveredCount = Math.max(0, uncoveredEnd - uncoveredStart);
      if (uncoveredCount > 0) {
        findings.push({
          kind: 'gap',
          detail: `${uncoveredCount} audit event(s) between seq ${coveredUpTo + 1n} and ${fromSeqBigint - 1n} are covered by no checkpoint`,
          atSeq: positionedEvents[uncoveredStart]!.entry.seq,
        });
      }

      if (fromSeqBigint <= coveredUpTo) {
        findings.push({
          kind: 'overlap',
          detail: `checkpoint ${cp.id} covers seq ${fromSeq}–${toSeq}, which re-attests history already covered up to ${coveredUpTo}`,
          atSeq: fromSeq,
        });
      }
      if (toSeqBigint > coveredUpTo) coveredUpTo = toSeqBigint;

      const rangeStart = lowerBound(positionedEvents, fromSeqBigint);
      const rangeEnd = upperBound(positionedEvents, toSeqBigint);
      const rangeLength = rangeEnd - rangeStart;
      if (BigInt(rangeLength) !== leafCountBigint) {
        findings.push({
          kind: 'missing_events',
          detail: `checkpoint ${cp.id} signed ${leafCount} events; ${rangeLength} remain in the log`,
          atSeq: fromSeq,
        });
      }

      const leaves: Buffer[] = [];
      for (let index = rangeStart; index < rangeEnd; index += 1) {
        leaves.push(leafHash(leafBytes(positionedEvents[index]!.entry, cp.format_version)));
      }
      const recomputed = merkleRoot(leaves).toString('hex');
      if (recomputed !== cp.merkle_root) {
        findings.push({
          kind: 'root_mismatch',
          detail: `checkpoint ${cp.id}: signed root ${cp.merkle_root}, recomputed ${recomputed}`,
          atSeq: fromSeq,
        });
      }

      const publicKey = publicKeys.get(cp.signing_key_id);
      if (publicKey === undefined) {
        findings.push({
          kind: 'unknown_key',
          detail: `checkpoint ${cp.id} is signed by ${cp.signing_key_id}, for which no public key was supplied`,
          atSeq: fromSeq,
        });
        continue;
      }
      const storedCheckpoint: Checkpoint = {
        formatVersion: cp.format_version,
        fromSeq,
        toSeq,
        merkleRoot: cp.merkle_root,
        signature: cp.signature,
        signingKeyId: cp.signing_key_id,
        leafCount,
      };
      if (!verifyCheckpoint(storedCheckpoint, publicKey)) {
        findings.push({
          kind: 'bad_signature',
          detail: `checkpoint ${cp.id} does not verify under key ${cp.signing_key_id}`,
          atSeq: fromSeq,
        });
      }
    }

    return findings;
  });
}
