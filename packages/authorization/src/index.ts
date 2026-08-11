/**
 * Role resolution and action permission
 *
 * Paired with PostgreSQL row-level security, never a substitute for it. A denial must be
 * explainable without revealing data the actor may not see.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/authorization',
  role: 'Role resolution and action permission',
  owns: [],
};
