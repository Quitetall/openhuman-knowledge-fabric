import { canonicalize } from '@kf/canonicalization';
import { readSmallRegularFile, type ScannedFile } from './file-tree.js';
import {
  CANONICAL_BASE64,
  SAFE_KEY_ID,
  SHA256,
  assertRequiredFiles,
  exactKeys,
  isRecord,
  isSafePath,
} from './format.js';
import {
  BACKUP_MANIFEST_FORMAT,
  BACKUP_MANIFEST_PATH,
  BACKUP_MANIFEST_SIGNATURE_FORMAT,
  BACKUP_MANIFEST_SIGNATURE_PATH,
  type BackupManifest,
  type BackupManifestFile,
  type BackupManifestSignature,
} from './types.js';

export function databaseSnapshotDigest(files: ReadonlyMap<string, ScannedFile>): string {
  const innerManifest = files.get('export/manifest.json');
  if (innerManifest === undefined) {
    throw new Error('required backup file missing: export/manifest.json');
  }
  let value: unknown;
  try {
    value = JSON.parse(readSmallRegularFile(innerManifest).toString('utf8')) as unknown;
  } catch {
    throw new Error('export/manifest.json is not JSON');
  }
  const digest = isRecord(value) ? value['database_snapshot_sha256'] : undefined;
  if (typeof digest !== 'string' || !SHA256.test(digest)) {
    throw new Error('export/manifest.json has no exact database_snapshot_sha256');
  }
  return digest;
}

export function validateCompatibilitySums(
  files: ReadonlyMap<string, ScannedFile>,
  manifest: BackupManifest,
): void {
  const sumsFile = files.get('SHA256SUMS');
  if (sumsFile === undefined) throw new Error('required backup file missing: SHA256SUMS');
  const expected = new Map(
    manifest.files
      .filter((entry) => entry.path !== 'SHA256SUMS')
      .map((entry) => [entry.path, entry.sha256]),
  );
  const seen = new Set<string>();
  const text = readSmallRegularFile(sumsFile).toString('utf8');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line);
    const path = match?.[2];
    if (
      match === null ||
      path === undefined ||
      !isSafePath(path) ||
      seen.has(path) ||
      !expected.has(path)
    ) {
      throw new Error('SHA256SUMS has an unsafe, duplicate, or unlisted entry');
    }
    if (expected.get(path) !== match[1]) {
      throw new Error(`digest mismatch in SHA256SUMS for ${path}`);
    }
    seen.add(path);
  }
  for (const path of expected.keys()) {
    if (!seen.has(path)) throw new Error(`SHA256SUMS is missing ${path}`);
  }
}

export function parseManifest(bytes: Buffer): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${BACKUP_MANIFEST_PATH} is not JSON`);
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ['database_snapshot_sha256', 'files', 'format_version'])
  ) {
    throw new Error(`${BACKUP_MANIFEST_PATH} has an invalid closed schema`);
  }
  if (
    value['format_version'] !== BACKUP_MANIFEST_FORMAT ||
    typeof value['database_snapshot_sha256'] !== 'string' ||
    !SHA256.test(value['database_snapshot_sha256']) ||
    !Array.isArray(value['files'])
  ) {
    throw new Error(`${BACKUP_MANIFEST_PATH} has an unsupported format or invalid files list`);
  }

  const files: BackupManifestFile[] = [];
  const paths = new Set<string>();
  for (const entry of value['files']) {
    if (!isRecord(entry) || !exactKeys(entry, ['path', 'sha256', 'size_bytes'])) {
      throw new Error(`${BACKUP_MANIFEST_PATH} contains an invalid file entry`);
    }
    const path = entry['path'];
    const size = entry['size_bytes'];
    const digest = entry['sha256'];
    if (
      typeof path !== 'string' ||
      !isSafePath(path) ||
      path === BACKUP_MANIFEST_PATH ||
      path === BACKUP_MANIFEST_SIGNATURE_PATH ||
      paths.has(path) ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof digest !== 'string' ||
      !SHA256.test(digest)
    ) {
      throw new Error(`${BACKUP_MANIFEST_PATH} contains an unsafe or duplicate file entry`);
    }
    paths.add(path);
    files.push({ path, size_bytes: size, sha256: digest });
  }
  if (bytes.toString('utf8') !== `${canonicalize(value)}\n`) {
    throw new Error(`${BACKUP_MANIFEST_PATH} is not exact RFC 8785 canonical JSON`);
  }
  assertRequiredFiles(paths);
  return {
    format_version: BACKUP_MANIFEST_FORMAT,
    database_snapshot_sha256: value['database_snapshot_sha256'],
    files,
  };
}

export function parseSignature(bytes: Buffer): BackupManifestSignature {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${BACKUP_MANIFEST_SIGNATURE_PATH} is not JSON`);
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'algorithm',
      'format_version',
      'key_id',
      'manifest_sha256',
      'signature_base64',
    ])
  ) {
    throw new Error(`${BACKUP_MANIFEST_SIGNATURE_PATH} has an invalid closed schema`);
  }
  const keyId = value['key_id'];
  const manifestDigest = value['manifest_sha256'];
  const signature = value['signature_base64'];
  if (
    value['format_version'] !== BACKUP_MANIFEST_SIGNATURE_FORMAT ||
    value['algorithm'] !== 'Ed25519' ||
    typeof keyId !== 'string' ||
    !SAFE_KEY_ID.test(keyId) ||
    typeof manifestDigest !== 'string' ||
    !SHA256.test(manifestDigest) ||
    typeof signature !== 'string' ||
    !CANONICAL_BASE64.test(signature) ||
    Buffer.from(signature, 'base64').length !== 64 ||
    Buffer.from(signature, 'base64').toString('base64') !== signature ||
    bytes.toString('utf8') !== `${canonicalize(value)}\n`
  ) {
    throw new Error(`${BACKUP_MANIFEST_SIGNATURE_PATH} is invalid or non-canonical`);
  }
  return {
    format_version: BACKUP_MANIFEST_SIGNATURE_FORMAT,
    algorithm: 'Ed25519',
    key_id: keyId,
    manifest_sha256: manifestDigest,
    signature_base64: signature,
  };
}
