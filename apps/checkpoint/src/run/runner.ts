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
 * Runs in one transaction, under an advisory lock so two runs never sign the same range.
 *
 * It read the events `for share` until 2026-10-07, "so a concurrent write cannot land inside the
 * range after it was read". A row lock never did that: it holds rows that exist against UPDATE
 * and DELETE, which the audit log already refuses to everyone (append-only triggers), and it does
 * nothing about rows not yet inserted. What it did do was demand UPDATE privilege, which the
 * signer's role, kf_checkpoint, is deliberately never granted — so on the first host the signer
 * could not read the log at all ("permission denied for table audit_event", KF-WAR-0001
 * rehearsal). A checkpoint covers exactly the events this transaction's snapshot saw, and its
 * range is the seqs it signed, which `verifyChain` below checks link without a gap.
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
        where event.seq > $1 order by event.seq`,
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

    const objectKey =
      options.store === undefined
        ? null
        : `audit/checkpoints/${String(signed.fromSeq).padStart(12, '0')}-${String(
            signed.toSeq,
          ).padStart(12, '0')}.json`;

    // The row FIRST, then the object. The other order wedged the signer: an object written
    // before an insert that then failed stayed in the store, the next run computed the same
    // range, found the key occupied, and refused — every hour, forever, with the audit log
    // unsigned from that point on. Inserted first, a failed put rolls the row back with it.
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
        objectKey,
      ],
    );

    if (options.store !== undefined && objectKey !== null) {
      const body = Buffer.from(`${JSON.stringify(signed, null, 2)}\n`, 'utf8');
      // Create-only, and idempotent for exactly these bytes. The commit can still fail after
      // the put, leaving the object without its row; the retry signs the same range with the
      // same key (Ed25519 is deterministic) and produces byte-identical JSON, which is the
      // same attestation, not a replacement. Different bytes at the key are refused: a
      // checkpoint object that can be replaced is not evidence.
      const stored = await options.store.putIfAbsent(objectKey, body, 'application/json');
      const existing = await options.store.read(objectKey, stored.versionId, body.length + 1);
      if (!existing.equals(body)) {
        throw new Error(
          `a checkpoint object already exists at ${objectKey} with different content — ` +
            'refusing to replace it',
        );
      }
    }
    const storageUri = objectKey;

    return {
      status: 'signed',
      checkpoint: { ...signed, id: row.id, storageUri },
      eventCount: entries.length,
    };
  });
}
