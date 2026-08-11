/**
 * PostgreSQL access boundary
 *
 * The only package permitted to open a connection. Everything else receives a transaction
 * handle, so no code path can quietly acquire its own and escape the action transaction.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/database',
  role: 'PostgreSQL access boundary',
  owns: [],
};
