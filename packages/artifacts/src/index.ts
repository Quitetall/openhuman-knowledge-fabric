/** Artifact identity, upload verification, and immutable version recording. */

export {
  ArtifactRejected,
  type UploadTicket,
  type VerificationFailure,
  type VerifiedUpload,
} from './internal/artifact-contracts.js';
export { beginUpload, objectKey, verifyUpload } from './internal/upload.js';
export { recordVersion, verifyRecordedVersion } from './internal/recording.js';
export {
  REPLICABLE_ROLES,
  STORAGE_ACTION_IDS,
  StoreRegistry,
  createStorageActionAtoms,
  declareStore,
  hashLocation,
  locationsOf,
  readVersionBytes,
  replicateVersion,
  verifyLocation,
  type ArtifactLocationRole,
  type ArtifactLocationRow,
  type LocationVerification,
  type ReplicableRole,
  type StorageActionAtoms,
} from './locations.js';
export {
  InMemoryObjectStore,
  ObjectReadLimitExceeded,
  S3ObjectStore,
  digestOf,
  type ObjectStore,
  type S3Config,
  type StoredObject,
} from './store.js';

export const PACKAGE = {
  name: '@kf/artifacts',
  role: 'Artifact identity and digest verification',
  owns: [],
} as const;
