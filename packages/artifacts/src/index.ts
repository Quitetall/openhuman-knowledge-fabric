/**
 * Artifact identity and digest verification
 *
 * PostgreSQL owns artifact metadata and provenance; the object store owns the bytes. An
 * artifact version is immutable once created.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/artifacts',
  role: 'Artifact identity and digest verification',
  owns: [],
};
