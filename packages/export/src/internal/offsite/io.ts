import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { MAX_ARCHIVE_BYTES, OffsiteTransferRefused, refuse } from './contract.js';

export function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
export async function archiveFile(path: string): Promise<FileHandle> {
  if (!isAbsolute(path)) refuse();
  // O_NONBLOCK prevents a substituted FIFO from hanging before fstat can refuse it.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size < 1 ||
      metadata.size > MAX_ARCHIVE_BYTES
    )
      refuse();
    const header = Buffer.alloc(1);
    const first = await file.read(header, 0, 1, 0);
    if (first.bytesRead !== 1 || ![0x84, 0x85, 0x86, 0x87, 0xc1].includes(header[0]!)) refuse();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
export function fileStream(file: FileHandle, size: number): Readable {
  // Readable owns only its iterator, never the shared descriptor. destroy() on fs.ReadStream
  // closes a supplied fd even with autoClose=false, breaking the second pass and final close.
  async function* chunks(): AsyncGenerator<Buffer> {
    let position = 0;
    while (position < size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, size - position));
      const result = await file.read(chunk, 0, chunk.length, position);
      if (result.bytesRead === 0) refuse();
      position += result.bytesRead;
      yield chunk.subarray(0, result.bytesRead);
    }
  }
  return Readable.from(chunks(), { objectMode: false, highWaterMark: 64 * 1024 });
}
export async function inspect(
  body: Readable,
  size: number,
  abort: AbortController,
  file?: FileHandle,
): Promise<string> {
  const hash = createHash('sha256');
  let count = 0;
  const cancel = (): void => {
    body.destroy(new OffsiteTransferRefused());
  };
  abort.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (abort.signal.aborted) refuse();
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > size - count || abort.signal.aborted)
        refuse();
      hash.update(chunk);
      count += chunk.byteLength;
      if (file) await file.writeFile(chunk);
    }
    if (count !== size || abort.signal.aborted) refuse();
    return hash.digest('hex');
  } finally {
    abort.signal.removeEventListener('abort', cancel);
    body.destroy();
  }
}
export async function privateParent(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) refuse();
  const parent = dirname(path);
  if ((await realpath(parent)) !== parent) refuse();
  const metadata = await lstat(parent);
  if (
    !metadata.isDirectory() ||
    !process.getuid ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o7777) !== 0o700
  )
    refuse();
  return parent;
}
