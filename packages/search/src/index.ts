/**
 * Search over canonical records
 *
 * Access control is applied before results are returned. Indexes are disposable and must be
 * rebuildable from authoritative records.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/search',
  role: 'Search over canonical records',
  owns: [],
};
