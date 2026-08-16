/**
 * Preservation export, import and round-trip.
 *
 * Public package seam stays intentionally small. Cohesive internal atoms own format encoding,
 * section inventory, verification, signing, and restoration without becoming package exports.
 */

export * from './publication.js';

export type {
  CreateExportOptions,
  ExportFile,
  ExportManifest,
  ExportManifestSignature,
  ExportManifestSigningKey,
  ExportPackage,
  ExportVerificationOptions,
  SignExportOptions,
  VerificationFinding,
} from './internal/types.js';
export {
  EXPORT_FORMAT_VERSION,
  EXPORT_MANIFEST_SIGNATURE_PATH,
  LEGACY_UNSIGNED_EXPORT_WARNING,
} from './internal/types.js';
export { createExport } from './internal/exporter.js';
export { recomputeDatabaseSnapshotDigest } from './internal/encoding.js';
export {
  PRESERVATION_IMPORT_TARGETS,
  PRESERVATION_TABLE_EXCLUSIONS,
} from './internal/import-targets.js';
export { signExportPackage } from './internal/signer.js';
export { verifyExport } from './internal/verifier.js';
export { exportIdentity } from './internal/identity.js';
export { importExport } from './internal/importer.js';

export const PACKAGE = {
  name: '@kf/export',
  role: 'Preservation export and round-trip',
  owns: [],
} as const;
