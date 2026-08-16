/**
 * Audit checkpoint construction and signing.
 *
 * The hash chain already makes a retroactive edit detectable BY RECOMPUTATION — but only to
 * someone who has an older copy to compare against. A checkpoint removes that dependency: it
 * signs a Merkle root over a range of audit events with a key the API cannot reach, so
 * anyone holding the signature can tell whether history changed, without trusting the
 * database, the application, or whoever administers them.
 *
 * That is the whole point of running this as a separate process. A compromised API can forge
 * records; it cannot forge a checkpoint saying those records were always there.
 */

export type {
  AuditEntry,
  AuditSequence,
  Checkpoint,
  CheckpointFormat,
  ExactCheckpoint,
  LegacyCheckpoint,
  LegacyCheckpointFormat,
  SigningKey,
} from './sign/contracts.js';
export { auditSequence, checkpointSigningKeyId } from './sign/sequences.js';
export { leafBytes, verifyChain } from './sign/chain.js';
export { generateSigningKey, loadSigningKey } from './sign/keys.js';
export { buildCheckpoint, verifyCheckpoint } from './sign/checkpoint.js';
export { checkInclusion, proveInclusion } from './sign/inclusion.js';
