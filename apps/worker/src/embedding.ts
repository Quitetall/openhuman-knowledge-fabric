/**
 * Embed on ingest (§64A, KF-SAS-RQ-218, RQ-225).
 *
 * After an act commits, its outbox row names the objects it touched. The drain re-indexes them for
 * lexical search and, when a retrieval engine is configured, queues them in `retrieval.embed_pending`
 * in the SAME transaction that marks the row delivered — so a record is never indexed and silently
 * never embedded.
 *
 * The engine is reached from a separate pump, never from inside the drain, and never with a
 * transaction open: claim a batch (one short transaction, committed), send each record's text to
 * the engine's vectors-only write (no transaction), complete each one that the engine acknowledged
 * (another short transaction). The engine may be slow or down; the database does not wait for it.
 *
 * And the text goes only to a path that keeps none of it: the client refuses, before writing the
 * text, any engine whose handshake does not declare `vectors_only_write` from a local, pinned
 * embedder. The worker checks the same thing at startup and refuses to start without it.
 */

import { withTransaction, type Pool } from '@kf/database';
import { VECTORS_ONLY_WRITE, type RetrievalClient } from '@kf/retrieval';
import { OUTBOX_HANDLERS, type OutboxHandler } from './outbox.js';

/**
 * The default outbox handler, plus the embedding queue. Idempotent like the handler it wraps: an
 * object queued twice is queued once, with its claim cleared so the newer text is embedded.
 */
export const embeddingOutboxHandler: OutboxHandler = async (tx, payload) => {
  await OUTBOX_HANDLERS['*']!(tx, payload);
  const targets = Array.isArray(payload['targets'])
    ? payload['targets'].filter((id): id is string => typeof id === 'string')
    : [];
  if (targets.length === 0) return;
  await tx.query('select retrieval.enqueue_embedding($1::uuid[])', [targets]);
};

/**
 * Refuse to start against an engine that could persist record text or embed it off-host.
 *
 * Throws with the engine's reason; a composition root lets that end the process.
 */
export async function requireVectorsOnlyEngine(client: RetrievalClient): Promise<void> {
  const probe = await client.probe(VECTORS_ONLY_WRITE);
  if ('status' in probe) {
    throw new Error(`retrieval engine refused at startup: ${probe.reason}`);
  }
}

export interface EmbeddingDrainResult {
  readonly claimed: number;
  readonly embedded: number;
  /** Left queued; their lease lapses and a later drain retries them. */
  readonly failed: readonly { readonly objectId: string; readonly reason: string }[];
}

const DEFAULT_BATCH = 32;
const DEFAULT_LEASE_SECONDS = 120;

/** One pass of the embedding pump. */
export async function drainEmbeddings(
  pool: Pool,
  client: RetrievalClient,
  options: { readonly batchSize?: number; readonly leaseSeconds?: number } = {},
): Promise<EmbeddingDrainResult> {
  const claimed = await withTransaction(pool, (tx) =>
    tx.query<{
      object_id: string;
      organization_id: string;
      text: string | null;
      claim: string;
    }>('select object_id, organization_id, text, claim from retrieval.claim_embeddings($1, $2)', [
      options.batchSize ?? DEFAULT_BATCH,
      options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    ]),
  );

  let embedded = 0;
  const failed: { objectId: string; reason: string }[] = [];
  for (const row of claimed) {
    // No transaction is open here: the claim committed above, and the completion below is its own.
    const outcome = await client.writeVector({
      organizationId: row.organization_id,
      objectId: row.object_id,
      text: row.text ?? '',
    });
    if ('status' in outcome) {
      failed.push({ objectId: row.object_id, reason: outcome.reason });
      continue;
    }
    await withTransaction(pool, (tx) =>
      tx.query('select retrieval.complete_embedding($1, $2)', [row.object_id, row.claim]),
    );
    embedded += 1;
  }
  return { claimed: claimed.length, embedded, failed };
}
