import type { Tx } from '@kf/database';
import { requireUuid } from './validation.js';

/** Short outbox transaction: index target and enqueue expensive compilation outside its lock. */
export async function compilationOutboxHandler(
  tx: Tx,
  payload: Record<string, unknown>,
): Promise<void> {
  const actionId = requireUuid(payload['action_id'], 'outbox payload action_id');
  const targets = payload['targets'];
  if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== 'string') {
    throw new Error('compilation outbox payload must have exactly one target');
  }
  await tx.query('select search.index_object($1)', [targets[0]]);
  await tx.query(
    `select graphile_worker.add_job(
       'kf.compile_document', json_build_object('actionId', $1::text),
       'document-compilation', null, 12,
       'kf.compile_document:' || $1::text, 0, null, 'replace'
     )`,
    [actionId],
  );
}
