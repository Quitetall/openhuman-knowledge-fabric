import { readGranted } from '@kf/authorization';
import { bindPrincipal, withTransaction, type Pool, type Tx } from '@kf/database';
import type { AgentScope } from './types.js';

/** Bind the reader's scope. Every tool does this first; none of them may skip it. */
export async function scoped<T>(
  pool: Pool,
  scope: AgentScope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (tx) => {
    await bindPrincipal(tx, scope);
    return fn(tx);
  });
}

/**
 * Bind the reader's scope, then ask the read gate about the one object the tool is about
 * (ADR 0027, KF-SAS-RQ-039). Row-level security says what the principal is CLEARED for; a live
 * grant says what they may READ. An agent reads as its principal, so an object the principal is
 * cleared for but not granted answers `absent` — the same answer as no such object, because the
 * difference is itself information.
 */
export async function scopedToGranted<T>(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
  absent: T,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return scoped(pool, scope, async (tx) =>
    (await readGranted(tx, scope, objectId)) ? fn(tx) : absent,
  );
}
