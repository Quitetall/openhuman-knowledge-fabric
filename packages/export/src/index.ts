/**
 * Preservation export and round-trip
 *
 * Retention is unbounded and no database binary format survives that horizon, so the
 * canonical export is the durable record and must be provably derivable.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/export',
  role: 'Preservation export and round-trip',
  owns: [],
};
