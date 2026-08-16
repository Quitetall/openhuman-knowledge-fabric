import { canonicalize } from '@kf/canonicalization';
import type { BackupManifest } from './types.js';

export const SHA256 = /^[0-9a-f]{64}$/;
export const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const REQUIRED_FILES = [
  'README.md',
  'SHA256SUMS',
  'dump.pgcustom',
  'export/manifest.json',
  'export/manifest.signature.json',
  'postgres-client-versions.txt',
  'roles.sql',
  'schema.sql',
] as const;

/** Exact outer signature domain: UTF8(RFC8785(manifest) || LF). */
export function backupManifestSigningBytes(manifest: BackupManifest): Buffer {
  return Buffer.from(`${canonicalize(manifest)}\n`, 'utf8');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isSafePath(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((segment) => SAFE_PATH_SEGMENT.test(segment))
  );
}

export function assertRequiredFiles(paths: ReadonlySet<string>): void {
  for (const required of REQUIRED_FILES) {
    if (!paths.has(required)) throw new Error(`required backup file missing: ${required}`);
  }
}
