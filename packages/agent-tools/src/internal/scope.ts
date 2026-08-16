import { withTransaction, type Pool, type Tx } from '@kf/database';
import type { AgentScope } from './types.js';

/** Bind the reader's scope. Every tool does this first; none of them may skip it. */
export async function scoped<T>(
  pool: Pool,
  scope: AgentScope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (tx) => {
    await tx.query('select core.set_access_context($1, $2)', [
      scope.organizationId,
      scope.maxClassification,
    ]);
    return fn(tx);
  });
}
