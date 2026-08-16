import { isAbsolute } from 'node:path';
import { LamQuantCompatibilityRejected } from './contracts.js';

export function normalizeRelativePath(path: string, label: string): string {
  if (
    path === '' ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new LamQuantCompatibilityRejected(
      'invalid_manifest',
      `${label} must be a safe repository-relative POSIX path, got '${path}'`,
    );
  }
  return path;
}
