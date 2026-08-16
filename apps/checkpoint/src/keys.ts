import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareCanonicalText } from '@kf/canonicalization';
import { checkpointSigningKeyId } from './sign.js';

const KEY_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.pub$/;
const CANONICAL_PUBLIC_KEY_PEM =
  /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END PUBLIC KEY-----\n?$/;

function publicKey(pem: string, source: string): KeyObject {
  const normalized = pem.replaceAll('\r\n', '\n');
  if (normalized.includes('\r')) {
    throw new Error(`${source} public key is not canonical base64 PEM`);
  }
  const match = CANONICAL_PUBLIC_KEY_PEM.exec(normalized);
  if (match === null) {
    throw new Error(`${source} public key is not canonical base64 PEM`);
  }
  const lines = match[1]!.split('\n');
  if (
    lines.some(
      (line, index) =>
        line.length === 0 || line.length > 64 || (index < lines.length - 1 && line.length !== 64),
    )
  ) {
    throw new Error(`${source} public key is not canonical base64 PEM`);
  }
  const encoded = lines.join('');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error(`${source} public key is not canonical base64 PEM`);
  }
  const der = Buffer.from(encoded, 'base64');
  if (der.toString('base64') !== encoded) {
    throw new Error(`${source} public key is not canonical base64 PEM`);
  }
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${source} is not an Ed25519 public key`);
  }
  const canonicalDer = key.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(canonicalDer) || !canonicalDer.equals(der)) {
    throw new Error(`${source} public key is not canonical DER`);
  }
  return key;
}

/**
 * Load permanent checkpoint verification trust from an external directory.
 *
 * Each regular file is named `<signing-key-id>.pub`. Historical files remain after rotation;
 * removing one makes every checkpoint bearing that id unverifiable. Symlinks are refused so
 * the trust set cannot silently change when an unrelated path is replaced.
 */
export function loadVerificationKeyDirectory(directoryPath: string): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const entries = readdirSync(directoryPath, { withFileTypes: true }).sort((a, b) =>
    compareCanonicalText(a.name, b.name),
  );
  for (const entry of entries) {
    const match = KEY_FILE.exec(entry.name);
    if (match === null) continue;
    if (!entry.isFile()) {
      throw new Error(`checkpoint public key ${entry.name} must be a regular file`);
    }
    const id = checkpointSigningKeyId(match[1]!);
    const source = join(directoryPath, entry.name);
    keys.set(id, publicKey(readFileSync(source, 'utf8'), source));
  }
  if (keys.size === 0) {
    throw new Error(`checkpoint public key directory ${directoryPath} contains no *.pub keys`);
  }
  return keys;
}

export function loadSingleVerificationKey(id: string, filePath: string): Map<string, KeyObject> {
  const validatedId = checkpointSigningKeyId(id);
  return new Map([[validatedId, publicKey(readFileSync(filePath, 'utf8'), filePath)]]);
}
