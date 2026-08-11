/**
 * Schema, SHACL and graph-constraint validation
 *
 * Findings carry rule id, severity, object path and remediation. Errors block; warnings may
 * permit draft operation.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/validation',
  role: 'Schema, SHACL and graph-constraint validation',
  owns: [],
};
