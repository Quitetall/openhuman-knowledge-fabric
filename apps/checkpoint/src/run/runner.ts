import type { ObjectStore } from '@kf/artifacts';
import { GENESIS_DIGEST } from '@kf/canonicalization';
import { withTransaction, type Pool } from '@kf/database';

import { buildCheckpoint, type SigningKey, verifyChain } from '../sign.js';
import type { RawEvent, RunResult } from './contracts.js';
import { toEntry } from './events.js';
import { latestCheckpoint } from './latest.js';
import { CHECKPOINT_LOCK, EVENT_COLUMNS, EVENT_SOURCE } from './sql.js';

/**
 * Sign everything since the last checkpoint.
 *
 * Runs in one transaction, and takes the events with `for share` so a concurrent write cannot
 * land inside the range after it was read: a checkpoint claiming to cover seq 1–100 must cover
 * exactly the 1–100 that existed when it was signed.
 */
export async function runCheckpoint(
  pool: Pool,
  key: SigningKey,
  options: { readonly store?: ObjectStore; readonly minEvents?: number } = {},
): Promise<RunResult> {
  return withTransaction(pool, async (tx) => {
    // Only one checkpoint run at a time. Transaction-scoped, so it releases on commit
    // or rollback without a cleanup path.
    await tx.query('select pg_advisory_xact_lock($1)', [CHECKPOINT_LOCK]);

    const last = await latestCheckpoint(tx);
    const afterSeq = last?.toSeq ?? 0;
    const expectedFirstPrev = last?.endDigest ?? GENESIS_DIGEST;

    const rows = await tx.query<RawEvent>(
      `select ${EVENT_COLUMNS} from ${EVENT_SOURCE}
        where event.seq > $1 order by event.seq for share of event`,
      [afterSeq],
    );
    const entries = rows.map(toEntry);

    if (entries.length < (options.minEvents ?? 1)) {
      return { status: 'nothing_pending', eventCount: entries.length };
    }

    // buildCheckpoint refuses a broken chain; this call gives the caller the specific seq.
    const chain = verifyChain(entries, expectedFirstPrev);
    if (!chain.ok) {
      throw new Error(
        `refusing to checkpoint: the audit chain breaks at seq ${chain.atSeq} — ${chain.detail}`,
      );
    }

    const signed = buildCheckpoint(entries, key, expectedFirstPrev);

    let storageUri: string | null = null;
    if (options.store !== undefined) {
      const objectKey = `audit/checkpoints/${String(signed.fromSeq).padStart(12, '0')}-${String(
        signed.toSeq,
      ).padStart(12, '0')}.json`;
      // Refuse to overwrite. A checkpoint object that can be replaced is not evidence.
      if ((await options.store.head(objectKey)) !== undefined) {
        throw new Error(
          `a checkpoint object already exists at ${objectKey} — refusing to replace it`,
        );
      }
      await options.store.put(
        objectKey,
        Buffer.from(`${JSON.stringify(signed, null, 2)}\n`, 'utf8'),
        'application/json',
      );
      storageUri = objectKey;
    }

    const row = await tx.one<{ id: string }>(
      `insert into core.audit_checkpoint
         (format_version, from_seq, to_seq, leaf_count, merkle_root, signature,
          signing_key_id, storage_uri)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [
        signed.formatVersion,
        signed.fromSeq,
        signed.toSeq,
        signed.leafCount,
        signed.merkleRoot,
        signed.signature,
        signed.signingKeyId,
        storageUri,
      ],
    );

    return {
      status: 'signed',
      checkpoint: { ...signed, id: row.id, storageUri },
      eventCount: entries.length,
    };
  });
}
