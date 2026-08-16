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

export type { LedgerFinding, RunResult, StoredCheckpoint } from './run/contracts.js';
export { runCheckpoint } from './run/runner.js';
export { verifyLedger } from './run/ledger.js';
