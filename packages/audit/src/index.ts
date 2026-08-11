/**
 * Append-only audit and Merkle checkpoints
 *
 * Audit rows cannot be updated or deleted through application roles. The checkpoint signing
 * key is not reachable from the API process.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/audit',
  role: 'Append-only audit and Merkle checkpoints',
  owns: [],
};
