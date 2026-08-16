import { digest as digestOf } from '@kf/canonicalization';
import type { ExportManifest } from './types.js';

/** Semantic identity of an export: the digest of its manifest minus the file list. */
export function exportIdentity(manifest: ExportManifest): string {
  const { files: _files, ...rest } = manifest;
  return digestOf(rest);
}
