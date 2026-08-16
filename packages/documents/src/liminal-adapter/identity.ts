import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { digest } from '@kf/canonicalization';
import { HASH_BUFFER_BYTES, MAX_RUNTIME_CLOSURE_BYTES, MAX_RUNTIME_FILE_BYTES } from './limits.js';

export function runtimeClosureDigest(
  entries: readonly { readonly path: string; readonly contentDigest: string }[],
): string {
  return digest(entries.map(({ path, contentDigest }) => ({ path, contentDigest })));
}

export function boundedRuntimeTotal(path: string, size: number, currentTotal: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Liminal runtime file has invalid size: ${path}`);
  }
  if (size > MAX_RUNTIME_FILE_BYTES) {
    throw new Error(
      `Liminal runtime file exceeded ${String(MAX_RUNTIME_FILE_BYTES)} bytes: ${path}`,
    );
  }
  const total = currentTotal + size;
  if (!Number.isSafeInteger(total) || total > MAX_RUNTIME_CLOSURE_BYTES) {
    throw new Error(`Liminal runtime closure exceeded ${String(MAX_RUNTIME_CLOSURE_BYTES)} bytes`);
  }
  return total;
}

export async function digestOpenFile(file: FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.byteLength, size - offset);
    const { bytesRead } = await file.read(buffer, 0, length, offset);
    if (bytesRead === 0) {
      throw new Error('Liminal runtime file changed size while being captured');
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest('hex');
}

/**
 * Calculate registry identity for ordered runtime paths.
 *
 * First occurrence wins for duplicate paths, matching adapter construction. Registry tooling
 * should call this only over normalized absolute paths accepted by the adapter.
 */
export async function digestLiminalRuntimeClosure(paths: readonly string[]): Promise<string> {
  const uniquePaths = [...new Set(paths)];
  const entries: { path: string; contentDigest: string }[] = [];
  let totalBytes = 0;
  for (const path of uniquePaths) {
    const file = await open(path, 'r');
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) {
        throw new Error(`Liminal runtime path is not a regular file: ${path}`);
      }
      totalBytes = boundedRuntimeTotal(path, metadata.size, totalBytes);
      entries.push({ path, contentDigest: await digestOpenFile(file, metadata.size) });
    } finally {
      await file.close();
    }
  }
  return runtimeClosureDigest(entries);
}
