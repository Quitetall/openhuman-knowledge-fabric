import { createPublicKey, type KeyObject } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { compareCanonicalText } from '@kf/canonicalization';
import type { ExportFile, ExportManifest, ExportPackage } from '../index.js';

const SAFE_KEY_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.pub$/;
const MAX_EXPORT_FILE_BYTES = 128 * 1024 * 1024;
const MAX_EXPORT_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES = 64 * 1024;

export function writePackage(dir: string, pkg: ExportPackage): void {
  for (const file of pkg.files) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, 'utf8');
  }
}

function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile()) throw new Error(`${label} is not a regular file`);
    if (!Number.isSafeInteger(status.size) || status.size < 0 || status.size > maximumBytes) {
      throw new Error(`${label} exceeds its ${maximumBytes} byte read limit`);
    }
    const bytes = Buffer.alloc(status.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const overflow = Buffer.allocUnsafe(1);
    if (offset !== bytes.length || readSync(descriptor, overflow, 0, 1, null) !== 0) {
      throw new Error(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** Read a directory back as a package. Paths are normalised to forward slashes. */
export function readPackage(dir: string): ExportPackage {
  const root = resolve(dir);
  const rootStatus = lstatSync(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error(`${dir} must be a real export directory, not a link`);
  }
  const files: { path: string; content: string }[] = [];
  let packageBytes = 0;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      compareCanonicalText(a.name, b.name),
    )) {
      const full = join(current, entry.name);
      const status = lstatSync(full);
      if (entry.isSymbolicLink() || status.isSymbolicLink()) {
        throw new Error(`${full} is a symbolic link; preservation packages must contain bytes`);
      }
      if (entry.isDirectory() && status.isDirectory()) walk(full);
      else if (entry.isFile() && status.isFile()) {
        const remainingPackageBytes = MAX_EXPORT_PACKAGE_BYTES - packageBytes;
        const maximumBytes = Math.min(MAX_EXPORT_FILE_BYTES, remainingPackageBytes);
        const bytes = readBoundedRegularFile(full, maximumBytes, full);
        packageBytes += bytes.length;
        files.push({
          path: relative(root, full).split(sep).join('/'),
          content: bytes.toString('utf8'),
        });
      } else {
        throw new Error(`${full} is not a regular file`);
      }
    }
  };
  walk(root);

  const manifestFile = files.find((file) => file.path === 'manifest.json');
  if (manifestFile === undefined) throw new Error(`${dir} has no manifest.json`);
  return { files, manifest: JSON.parse(manifestFile.content) as ExportManifest };
}

function readPublicKeyDirectory(
  dir: string,
  purpose: 'preservation trust store' | 'checkpoint public-key archive',
): readonly { keyId: string; name: string; content: string; publicKey: KeyObject }[] {
  const root = resolve(dir);
  const rootStatus = lstatSync(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error(`${purpose} ${dir} must be a real directory, not a link`);
  }
  const keys: { keyId: string; name: string; content: string; publicKey: KeyObject }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    compareCanonicalText(a.name, b.name),
  )) {
    const match = SAFE_KEY_FILE.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
      throw new Error(
        `${purpose} contains ${entry.name}; expected only regular <signing-key-id>.pub files`,
      );
    }
    const path = join(root, entry.name);
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`${purpose} file ${entry.name} changed before it could be read`);
    }
    if (status.size > MAX_PUBLIC_KEY_BYTES) {
      throw new Error(`${purpose} file ${entry.name} exceeds ${MAX_PUBLIC_KEY_BYTES} bytes`);
    }
    const bytes = readBoundedRegularFile(
      path,
      MAX_PUBLIC_KEY_BYTES,
      `${purpose} file ${entry.name}`,
    );
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) {
      throw new Error(`${purpose} file ${entry.name} is not exact UTF-8 PEM`);
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
      throw new Error(`${purpose} file ${entry.name} contains private key material`);
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(content);
    } catch {
      throw new Error(`${purpose} file ${entry.name} is not a public key PEM`);
    }
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(`${purpose} file ${entry.name} is not a public Ed25519 key`);
    }
    keys.push({ keyId: match[1]!, name: entry.name, content, publicKey });
  }
  if (keys.length === 0) throw new Error(`${purpose} ${dir} contains no public keys`);
  return keys;
}

export function loadTrustStore(dir: string): ReadonlyMap<string, KeyObject> {
  return new Map(
    readPublicKeyDirectory(dir, 'preservation trust store').map((entry) => [
      entry.keyId,
      entry.publicKey,
    ]),
  );
}

export function checkpointPublicKeys(dir: string | undefined): readonly ExportFile[] {
  if (dir === undefined || dir === '') return [];
  return readPublicKeyDirectory(dir, 'checkpoint public-key archive').map((entry) => ({
    path: `trust/checkpoint/${entry.name}`,
    content: entry.content,
  }));
}
