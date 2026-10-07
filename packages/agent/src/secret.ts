/**
 * A credential is read from a file its owner alone can read, on every use, and never from the
 * environment (KF-WAR-0006 work order 3; packages/operations/src/secrets.ts states why).
 *
 * The provider's API key and LAMU's bearer reach this process only this way. A file another account
 * can read is refused: that account already holds the key. Nothing here puts a value in an error.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export class CredentialRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialRefused';
  }
}

/** The trimmed contents of an owner-only file of at most 4 KiB. */
export function readOwnerOnlyFile(path: string, label: string): string {
  if (!isAbsolute(path)) throw new CredentialRefused(`${label}: ${path} is not an absolute path`);
  let mode: number;
  let size: number;
  try {
    const info = statSync(path);
    if (!info.isFile()) throw new Error('not a file');
    mode = info.mode;
    size = info.size;
  } catch {
    throw new CredentialRefused(`${label}: ${path} cannot be read`);
  }
  if ((mode & 0o077) !== 0) {
    throw new CredentialRefused(
      `${label}: ${path} is readable by an account other than its owner; chmod 600 it`,
    );
  }
  if (size === 0 || size > 4096) {
    throw new CredentialRefused(`${label}: ${path} must hold between 1 byte and 4 KiB`);
  }
  const value = readFileSync(path, 'utf8').trim();
  if (value === '') throw new CredentialRefused(`${label}: ${path} is empty`);
  return value;
}
