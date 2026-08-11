/**
 * Typed action dispatcher
 *
 * Owns the transition, never the fact. Every controlled state change passes through
 * executeAction in one transaction, with authority, preconditions, audit and outbox.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/actions',
  role: 'Typed action dispatcher',
  owns: [],
};
