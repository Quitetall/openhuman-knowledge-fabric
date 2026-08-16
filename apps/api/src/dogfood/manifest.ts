import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digestOf, verifyUpload, type ObjectStore } from '@kf/artifacts';
import { mediaTypeForDocumentFile } from '@kf/documents';
import type { ManifestEntry, StagedConstitution, StagedSource } from './contracts.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const MANIFEST = join(ROOT, 'dogfood', 'document-constitution.json');

function manifestEntry(value: unknown, index: number): ManifestEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Manifest entry ${index + 1} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const read = (key: string): string => {
    const field = record[key];
    if (typeof field !== 'string' || field.trim() === '') {
      throw new Error(`Manifest entry ${index + 1} has invalid ${key}.`);
    }
    return field;
  };
  return {
    file: read('file'),
    title: read('title'),
    documentNumber: read('documentNumber'),
    revision: read('revision'),
    documentClass: read('documentClass'),
    owningRole: read('owningRole'),
  };
}

async function readManifest(): Promise<{
  readonly bytes: Buffer;
  readonly entries: readonly ManifestEntry[];
}> {
  const bytes = await readFile(MANIFEST);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Dogfood manifest is empty.');
  return { bytes, entries: raw.map(manifestEntry) };
}

async function sourceFile(directory: string, file: string): Promise<Buffer> {
  const root = await realpath(directory);
  const candidate = await realpath(resolve(root, file));
  const fromRoot = relative(root, candidate);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Manifest source escapes source directory: ${file}`);
  }
  return readFile(candidate);
}

async function stageContentAddressedObject(
  store: ObjectStore,
  key: string,
  bytes: Buffer,
  mediaType: string,
): Promise<void> {
  await store.putIfAbsent(key, bytes, mediaType);
  await verifyUpload(store, {
    key,
    claimedSha256: digestOf(bytes),
    claimedSizeBytes: bytes.length,
  });
}

export async function stageDocumentConstitution(
  directory: string,
  store: ObjectStore,
): Promise<StagedConstitution> {
  const manifest = await readManifest();
  const sources: StagedSource[] = [];
  for (const entry of manifest.entries) {
    const bytes = await sourceFile(directory, entry.file);
    const mediaType = mediaTypeForDocumentFile(entry.file);
    if (mediaType === undefined) throw new Error(`Unsupported document file: ${entry.file}`);
    const sha256 = digestOf(bytes);
    const key = `document-imports/${sha256}`;
    await stageContentAddressedObject(store, key, bytes, mediaType);
    sources.push({ entry, bytes, mediaType, sha256, key });
  }
  const manifestSha256 = digestOf(manifest.bytes);
  const manifestKey = `document-imports/${manifestSha256}`;
  await stageContentAddressedObject(store, manifestKey, manifest.bytes, 'application/json');
  return {
    sources,
    manifest: {
      bytes: manifest.bytes,
      sha256: manifestSha256,
      key: manifestKey,
      fileName: basename(MANIFEST),
    },
  };
}
