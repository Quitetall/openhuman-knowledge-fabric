/**
 * Schema, SHACL and graph-constraint validation — a manifest, not an implementation.
 *
 * Nothing here runs or blocks. Shapes are emitted by the ontology compiler for other tools;
 * integrity is enforced by the database. See AUTHORITY.md.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/validation',
  role: 'Schema, SHACL and graph-constraint validation',
  owns: [],
};
