/**
 * Shared presentation components
 *
 * No business rules, no authority decisions. A view may summarize and calculate but never
 * becomes an edited source of truth.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/ui',
  role: 'Shared presentation components',
  owns: [],
};
