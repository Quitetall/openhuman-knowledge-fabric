/**
 * The checkpoint run: read the audit log, verify it, sign it, and put the signature somewhere
 * the database cannot reach.
 *
 * A hash chain detects a retroactive edit only by RECOMPUTATION, and only for someone holding
 * an older copy. Whoever can rewrite the audit table can rewrite the chain over it and the
 * result verifies perfectly. Checkpoints are what remove that hole: a signature over a Merkle
 * root, produced by a process with a key the API does not have and stored where the database
 * administrator is not the same principal.
 *
 * The chain is still what makes a checkpoint cheap — sign a root every hour rather than every
 * record — and the checkpoint is what makes the chain mean something to an outsider.
 */

import { GENESIS_DIGEST } from '@kf/canonicalization';
import { withTransaction, type Pool, type Tx } from '@kf/database';
import type { ObjectStore } from '@kf/artifacts';
import type { KeyObject } from 'node:crypto';
import {
  buildCheckpoint,
  leafBytes,
  verifyChain,
  verifyCheckpoint,
  type AuditEntry,
  type Checkpoint,
  type SigningKey,
} from './sign.js';
import { leafHash, merkleRoot } from './merkle.js';

/**
 * Advisory lock key for the checkpoint run. An arbitrary constant — advisory locks carry no
 * meaning beyond agreement between the processes that take them.
 */
const CHECKPOINT_LOCK = 0x6b665f6370;

/** Rows the checkpoint reads. Deliberately the same shape the export writes. */
const EVENT_COLUMNS = `seq, id, action_id, actor_id, action_type, recorded_at,
                       prev_digest, digest`;

interface RawEvent extends Record<string, unknown> {
  seq: string;
  id: string;
  action_id: string;
  actor_id: string;
  action_type: string;
  recorded_at: Date;
  prev_digest: string;
  digest: string;
}

function toEntry(r: RawEvent): AuditEntry {
  return {
    // bigserial arrives as a string; a checkpoint that hashed "5" one run and 5 the next
    // would produce two different roots for the same history.
    seq: Number(r.seq),
    id: r.id,
    action_id: r.action_id,
    actor_id: r.actor_id,
    action_type: r.action_type,
    recorded_at: r.recorded_at.toISOString(),
    prev_digest: r.prev_digest,
    digest: r.digest,
  };
}

export interface StoredCheckpoint extends Checkpoint {
  readonly id: string;
  readonly storageUri: string | null;
}

async function latestCheckpoint(tx: Tx): Promise<{ toSeq: number; endDigest: string } | null> {
  const row = await tx.maybeOne<{ to_seq: string }>(
    'select to_seq from core.audit_checkpoint order by to_seq desc limit 1',
  );
  if (row === undefined) return null;
  const toSeq = Number(row.to_seq);
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

export interface RunResult {
  readonly status: 'signed' | 'nothing_pending';
  readonly checkpoint?: StoredCheckpoint;
  readonly eventCount: number;
}

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
    // Only one checkpoint run at a time. Two concurrent runs would each read the same last
    // checkpoint and the same pending range, and both would sign it: duplicate attestations
    // over identical history. Harmless to verification, but it makes the ledger read as
    // though something were wrong, and an auditor should never have to work out which of two
    // signatures for seq 1–100 was the real one. Transaction-scoped, so it releases on commit
    // or rollback without a cleanup path.
    await tx.query('select pg_advisory_xact_lock($1)', [CHECKPOINT_LOCK]);

    const last = await latestCheckpoint(tx);
    const afterSeq = last?.toSeq ?? 0;
    const expectedFirstPrev = last?.endDigest ?? GENESIS_DIGEST;

    const rows = await tx.query<RawEvent>(
      `select ${EVENT_COLUMNS} from core.audit_event
        where seq > $1 order by seq for share`,
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
      // Refuse to overwrite. A checkpoint object that can be replaced is not evidence, and
      // silently replacing one would destroy the only copy of an earlier attestation.
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
         (from_seq, to_seq, leaf_count, merkle_root, signature, signing_key_id, storage_uri)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [
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

export interface LedgerFinding {
  readonly kind:
    | 'chain_broken'
    | 'root_mismatch'
    | 'bad_signature'
    | 'unknown_key'
    | 'gap'
    | 'overlap'
    | 'missing_events';
  readonly detail: string;
  readonly atSeq?: number;
}

/**
 * Recompute everything from genesis and check it against what was signed.
 *
 * This is the audit itself, not a health check: it walks the chain from the first event,
 * rebuilds each checkpoint's Merkle root from the events actually in the table, and verifies
 * each signature against the public key. Anything a tamperer changed shows up in at least one
 * of the three, because the three are not derived from each other.
 *
 * Returns findings rather than throwing: an auditor wants the full list, not the first
 * problem.
 */
export async function verifyLedger(
  pool: Pool,
  publicKeys: ReadonlyMap<string, KeyObject>,
): Promise<LedgerFinding[]> {
  return withTransaction(pool, async (tx) => {
    const findings: LedgerFinding[] = [];

    const events = (
      await tx.query<RawEvent>(`select ${EVENT_COLUMNS} from core.audit_event order by seq`)
    ).map(toEntry);

    const chain = verifyChain(events, GENESIS_DIGEST);
    if (!chain.ok) {
      findings.push({ kind: 'chain_broken', detail: chain.detail, atSeq: chain.atSeq });
    }

    const checkpoints = await tx.query<{
      id: string;
      from_seq: string;
      to_seq: string;
      leaf_count: string;
      merkle_root: string;
      signature: string;
      signing_key_id: string;
    }>(
      `select id, from_seq, to_seq, leaf_count, merkle_root, signature, signing_key_id
         from core.audit_checkpoint order by from_seq`,
    );

    let coveredUpTo = 0;
    for (const cp of checkpoints) {
      const fromSeq = Number(cp.from_seq);
      const toSeq = Number(cp.to_seq);
      const leafCount = Number(cp.leaf_count);

      // A gap is an EVENT nobody attested to — not merely a numeric discontinuity, because
      // sequence numbers legitimately skip where transactions rolled back.
      const uncovered = events.filter((e) => e.seq > coveredUpTo && e.seq < fromSeq);
      if (uncovered.length > 0) {
        findings.push({
          kind: 'gap',
          detail: `${uncovered.length} audit event(s) between seq ${coveredUpTo + 1} and ${fromSeq - 1} are covered by no checkpoint`,
          atSeq: uncovered[0]!.seq,
        });
      }

      // Overlap is the opposite failure and just as important: the same events attested twice
      // means two signatures describe one span of history, and if one was produced before a
      // tamper and one after, they disagree while both verify. A gap check alone misses this
      // entirely — the uncovered range above is empty when ranges overlap.
      if (fromSeq <= coveredUpTo) {
        findings.push({
          kind: 'overlap',
          detail: `checkpoint ${cp.id} covers seq ${fromSeq}–${toSeq}, which re-attests history already covered up to ${coveredUpTo}`,
          atSeq: fromSeq,
        });
      }
      coveredUpTo = Math.max(coveredUpTo, toSeq);

      const range = events.filter((e) => e.seq >= fromSeq && e.seq <= toSeq);
      if (range.length !== leafCount) {
        // Fewer leaves than were signed means events were removed from a range already
        // attested to. This is the deletion detector, and it fires before any root check.
        findings.push({
          kind: 'missing_events',
          detail: `checkpoint ${cp.id} signed ${leafCount} events; ${range.length} remain in the log`,
          atSeq: fromSeq,
        });
      }

      const recomputed = merkleRoot(range.map((e) => leafHash(leafBytes(e)))).toString('hex');
      if (recomputed !== cp.merkle_root) {
        findings.push({
          kind: 'root_mismatch',
          detail: `checkpoint ${cp.id}: signed root ${cp.merkle_root}, recomputed ${recomputed}`,
          atSeq: fromSeq,
        });
      }

      const publicKey = publicKeys.get(cp.signing_key_id);
      if (publicKey === undefined) {
        // Unverifiable is not the same as valid. Recorded as a finding so an unknown key can
        // never read as a pass.
        findings.push({
          kind: 'unknown_key',
          detail: `checkpoint ${cp.id} is signed by ${cp.signing_key_id}, for which no public key was supplied`,
          atSeq: fromSeq,
        });
        continue;
      }
      const ok = verifyCheckpoint(
        {
          fromSeq,
          toSeq,
          merkleRoot: cp.merkle_root,
          signature: cp.signature,
          signingKeyId: cp.signing_key_id,
          leafCount,
        },
        publicKey,
      );
      if (!ok) {
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
