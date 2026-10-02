/** Version-pinned ciphertext transport; authentication and copy-ledger writes stay with callers. */
export {
  OffsiteTransferRefused,
  type B2ArchiveConfiguration,
  type OffsiteArchiveCopy,
  type OffsiteArchiveStore,
} from './internal/offsite/contract.js';
export { createB2ArchiveStore } from './internal/offsite/b2.js';
