import { sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import {
  assertRealDirectory,
  createStageDirectory,
  hashRegularFile,
  readSmallRegularFile,
  scanRegularFiles,
  writeExclusiveFsynced,
} from './file-tree.js';
import { SAFE_KEY_ID, assertRequiredFiles } from './format.js';
import { backupManifestSigningBytes } from './format.js';
import {
  databaseSnapshotDigest,
  parseManifest,
  parseSignature,
  validateCompatibilitySums,
} from './schema.js';
import {
  BACKUP_MANIFEST_FORMAT,
  BACKUP_MANIFEST_PATH,
  BACKUP_MANIFEST_SIGNATURE_FORMAT,
  BACKUP_MANIFEST_SIGNATURE_PATH,
  type BackupManifest,
  type BackupManifestSignature,
  type BackupManifestSigningKey,
  type VerifyBackupOptions,
} from './types.js';

/** Sign a complete backup tree. Existing sidecars are refused rather than followed/overwritten. */
export function signBackupDirectory(
  root: string,
  signingKey: BackupManifestSigningKey,
): BackupManifest {
  if (!SAFE_KEY_ID.test(signingKey.keyId)) throw new Error('backup signing key id is invalid');
  if (
    signingKey.privateKey.type !== 'private' ||
    signingKey.privateKey.asymmetricKeyType !== 'ed25519'
  ) {
    throw new Error('backup signing key must be a private Ed25519 key');
  }
  const absolute = assertRealDirectory(root);
  const scanned = scanRegularFiles(absolute);
  const scannedByPath = new Map(scanned.map((entry) => [entry.path, entry]));
  const scannedPaths = new Set(scannedByPath.keys());
  if (scannedPaths.has(BACKUP_MANIFEST_PATH) || scannedPaths.has(BACKUP_MANIFEST_SIGNATURE_PATH)) {
    throw new Error('backup root manifest sidecars already exist; refusing to overwrite them');
  }
  assertRequiredFiles(scannedPaths);
  const manifest: BackupManifest = {
    format_version: BACKUP_MANIFEST_FORMAT,
    database_snapshot_sha256: databaseSnapshotDigest(scannedByPath),
    files: scanned.map((entry) => ({
      path: entry.path,
      size_bytes: entry.size,
      sha256: hashRegularFile(entry),
    })),
  };
  validateCompatibilitySums(scannedByPath, manifest);
  const manifestBytes = backupManifestSigningBytes(manifest);
  const signature: BackupManifestSignature = {
    format_version: BACKUP_MANIFEST_SIGNATURE_FORMAT,
    algorithm: 'Ed25519',
    key_id: signingKey.keyId,
    manifest_sha256: digestBytes(manifestBytes),
    signature_base64: edSign(null, manifestBytes, signingKey.privateKey).toString('base64'),
  };
  writeExclusiveFsynced(join(absolute, BACKUP_MANIFEST_PATH), manifestBytes);
  writeExclusiveFsynced(
    join(absolute, BACKUP_MANIFEST_SIGNATURE_PATH),
    Buffer.from(`${canonicalize(signature)}\n`, 'utf8'),
  );
  return manifest;
}

/** Authenticate and hash every regular file before restore tooling may consume any of them. */
export function verifyBackupDirectory(
  root: string,
  trustedKeys: ReadonlyMap<string, KeyObject>,
  options: VerifyBackupOptions = {},
): BackupManifest {
  const scanned = scanRegularFiles(root);
  const actual = new Map(scanned.map((entry) => [entry.path, entry]));
  const manifestFile = actual.get(BACKUP_MANIFEST_PATH);
  if (manifestFile === undefined) throw new Error(`missing ${BACKUP_MANIFEST_PATH}`);
  const signatureFile = actual.get(BACKUP_MANIFEST_SIGNATURE_PATH);
  if (signatureFile === undefined) throw new Error(`missing ${BACKUP_MANIFEST_SIGNATURE_PATH}`);
  const manifestBytes = readSmallRegularFile(manifestFile);
  const signatureBytes = readSmallRegularFile(signatureFile);
  const manifest = parseManifest(manifestBytes);
  const signature = parseSignature(signatureBytes);
  const trustedKey = trustedKeys.get(signature.key_id);
  if (trustedKey === undefined) throw new Error(`unknown signing key ${signature.key_id}`);
  if (trustedKey.type !== 'public' || trustedKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`trusted key ${signature.key_id} is not a public Ed25519 key`);
  }
  if (signature.manifest_sha256 !== digestBytes(manifestBytes)) {
    throw new Error('backup manifest digest does not match its signature sidecar');
  }
  if (
    !edVerify(null, manifestBytes, trustedKey, Buffer.from(signature.signature_base64, 'base64'))
  ) {
    throw new Error(`backup manifest signature invalid for trusted key ${signature.key_id}`);
  }
  if (manifest.database_snapshot_sha256 !== databaseSnapshotDigest(actual)) {
    throw new Error('backup manifest database snapshot digest does not match inner export');
  }

  const listed = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const path of actual.keys()) {
    if (
      path !== BACKUP_MANIFEST_PATH &&
      path !== BACKUP_MANIFEST_SIGNATURE_PATH &&
      !listed.has(path)
    ) {
      throw new Error(`unlisted backup file present: ${path}`);
    }
  }
  validateCompatibilitySums(actual, manifest);
  const stagedRoot =
    options.stageDirectory === undefined
      ? undefined
      : createStageDirectory(root, options.stageDirectory);
  for (const entry of manifest.files) {
    const file = actual.get(entry.path);
    if (file === undefined) throw new Error(`listed backup file missing: ${entry.path}`);
    if (file.size !== entry.size_bytes) throw new Error(`size mismatch for ${entry.path}`);
    const stagedPath = stagedRoot === undefined ? undefined : join(stagedRoot, entry.path);
    if (hashRegularFile(file, stagedPath) !== entry.sha256) {
      throw new Error(`digest mismatch for ${entry.path}`);
    }
  }
  if (stagedRoot !== undefined) {
    writeExclusiveFsynced(join(stagedRoot, BACKUP_MANIFEST_PATH), manifestBytes);
    writeExclusiveFsynced(join(stagedRoot, BACKUP_MANIFEST_SIGNATURE_PATH), signatureBytes);
  }
  return manifest;
}
