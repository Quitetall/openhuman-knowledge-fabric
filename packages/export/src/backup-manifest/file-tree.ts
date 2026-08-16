import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { compareText, isSafePath } from './format.js';

const MAX_SIDECAR_BYTES = 16 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;

export interface ScannedFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly size: number;
}

export function assertRealDirectory(root: string): string {
  const absolute = resolve(root);
  const status = lstatSync(absolute);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`backup root ${root} must be a real directory, not a link`);
  }
  return absolute;
}

/** Return regular-file metadata without reading multi-gigabyte backup payloads into memory. */
export function scanRegularFiles(root: string): readonly ScannedFile[] {
  const absolute = assertRealDirectory(root);
  const files: ScannedFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const full = join(directory, entry.name);
      const path = relative(absolute, full).split(sep).join('/');
      if (!isSafePath(path)) throw new Error(`backup contains unsafe path ${JSON.stringify(path)}`);
      const status = lstatSync(full);
      if (status.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
      if (status.isDirectory()) {
        walk(full);
      } else if (status.isFile()) {
        if (!Number.isSafeInteger(status.size) || status.size < 0) {
          throw new Error(`${path} has an unrepresentable size`);
        }
        files.push({ path, absolutePath: full, size: status.size });
      } else {
        throw new Error(`${path} is not a regular file`);
      }
    }
  };
  walk(absolute);
  return files.sort((left, right) => compareText(left.path, right.path));
}

function openRegularFile(file: ScannedFile): number {
  const descriptor = openSync(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const status = fstatSync(descriptor);
  if (!status.isFile() || status.size !== file.size) {
    closeSync(descriptor);
    throw new Error(`${file.path} changed while backup manifest was being verified`);
  }
  return descriptor;
}

/** Hash through fixed-size chunks and optionally copy those exact verified bytes into staging. */
export function hashRegularFile(file: ScannedFile, stagedPath?: string): string {
  const descriptor = openRegularFile(file);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let total = 0;
  let stagedDescriptor: number | undefined;
  try {
    if (stagedPath !== undefined) {
      mkdirSync(dirname(stagedPath), { recursive: true, mode: 0o700 });
      stagedDescriptor = openSync(
        stagedPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    }
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      if (stagedDescriptor !== undefined) {
        let written = 0;
        while (written < read) {
          const count = writeSync(stagedDescriptor, buffer, written, read - written);
          if (count === 0) throw new Error(`staging ${file.path} made no write progress`);
          written += count;
        }
      }
      total += read;
    }
    if (stagedDescriptor !== undefined) fsyncSync(stagedDescriptor);
  } finally {
    if (stagedDescriptor !== undefined) closeSync(stagedDescriptor);
    closeSync(descriptor);
  }
  if (total !== file.size) throw new Error(`${file.path} changed while it was being hashed`);
  return hash.digest('hex');
}

export function createStageDirectory(sourceRoot: string, requested: string): string {
  const source = resolve(sourceRoot);
  const staged = resolve(requested);
  if (
    staged === source ||
    staged.startsWith(`${source}${sep}`) ||
    source.startsWith(`${staged}${sep}`)
  ) {
    throw new Error('staged backup directory must not contain or be contained by source backup');
  }
  mkdirSync(staged, { mode: 0o700 });
  return staged;
}

export function writeExclusiveFsynced(path: string, bytes: Buffer): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(descriptor, bytes, written, bytes.length - written);
      if (count === 0) throw new Error(`writing ${path} made no progress`);
      written += count;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function readSmallRegularFile(file: ScannedFile): Buffer {
  if (file.size > MAX_SIDECAR_BYTES) {
    throw new Error(`${file.path} exceeds ${MAX_SIDECAR_BYTES} byte metadata limit`);
  }
  const descriptor = openRegularFile(file);
  const bytes = Buffer.alloc(file.size);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
  } finally {
    closeSync(descriptor);
  }
  if (offset !== bytes.length) throw new Error(`${file.path} changed while it was being read`);
  return bytes;
}
