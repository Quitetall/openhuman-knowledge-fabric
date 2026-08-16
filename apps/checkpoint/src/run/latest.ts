import type { Tx } from '@kf/database';

import { auditSequence, type AuditSequence, type CheckpointFormat } from '../sign.js';
import { JS_SAFE_INTEGER_MAX } from './sql.js';

export async function latestCheckpoint(
  tx: Tx,
): Promise<{ toSeq: AuditSequence; endDigest: string } | null> {
  const row = await tx.maybeOne<{ to_seq: string; format_version: CheckpointFormat }>(
    'select to_seq, format_version from core.audit_checkpoint order by to_seq desc limit 1',
  );
  if (row === undefined) return null;
  const toSeq = auditSequence(row.to_seq);
  if (row.format_version !== 'kf.audit-checkpoint.v3' && BigInt(toSeq) > JS_SAFE_INTEGER_MAX) {
    throw new Error(
      `legacy checkpoint ending at seq ${toSeq} exceeds its exact numeric wire domain; migration to v3 requires external recovery evidence`,
    );
  }
  const end = await tx.maybeOne<{ digest: string }>(
    'select digest from core.audit_event where seq = $1',
    [toSeq],
  );
  if (end === undefined) {
    // The event a checkpoint attested to is gone. That is precisely the tampering
    // checkpoints exist to reveal, so it stops the run rather than starting a fresh chain.
    throw new Error(
      `audit event seq ${toSeq} is missing, but a checkpoint attests to it — the log has been truncated`,
    );
  }
  return { toSeq, endDigest: end.digest };
}
