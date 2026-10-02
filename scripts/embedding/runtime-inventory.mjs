import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';

export const FORMAT = 'kf-embedding-runtime-v1';
export const MANIFEST = 'RUNTIME-CLOSURE.json';
const MAX_FILES = 50_000;
const MAX_BYTES = 4 * 1024 ** 3;
const MAX_FILE_BYTES = 1024 ** 3;

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizedAbsolute(path) {
  if (!isAbsolute(path) || normalize(path) !== path || !/^\/[A-Za-z0-9._/+@=-]+$/.test(path)) {
    throw new Error('runtime_path_invalid');
  }
  return path;
}

export function protectedPath(path) {
  if (!isAbsolute(path) || normalize(path) !== path || !/^\/[A-Za-z0-9._/()+@= -]+$/.test(path)) {
    throw new Error('runtime_path_invalid');
  }
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error('runtime_custody_invalid');
    }
    if (current === '/') break;
  }
}

export function fileRecord(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error('runtime_file_invalid');
  const descriptor = openSync(path, 'r');
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error('runtime_file_changed');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      size += count;
      if (size > MAX_FILE_BYTES) throw new Error('runtime_file_too_large');
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('runtime_file_changed');
    return { sha256: hash.digest('hex'), size, mode: before.mode & 0o777 };
  } finally {
    closeSync(descriptor);
  }
}

/** Closed regular-file tree: links, devices, writable entries and unlisted files refuse. */
export function treeRecords(root) {
  const entries = [];
  let total = 0;
  function visit(directory) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0)
      throw new Error('runtime_directory_invalid');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const local = relative(root, path);
      // Package data includes literal spaces and parentheses (for example setuptools
      // templates). Paths are filesystem/argv values, never shell expressions.
      if (!/^[A-Za-z0-9._/()+@= -]+$/.test(local)) throw new Error('runtime_entry_invalid');
      if (local === MANIFEST) continue;
      const stat = lstatSync(path);
      if ((stat.mode & 0o022) !== 0) throw new Error('runtime_entry_writable');
      if (stat.isDirectory()) {
        entries.push({ path: local, type: 'directory', mode: stat.mode & 0o777 });
        visit(path);
      } else if (stat.isFile()) {
        const record = fileRecord(path);
        total += record.size;
        if (total > MAX_BYTES) throw new Error('runtime_tree_too_large');
        entries.push({ path: local, type: 'file', ...record });
      } else throw new Error('runtime_entry_not_regular');
      if (entries.length > MAX_FILES) throw new Error('runtime_tree_too_many_entries');
    }
  }
  visit(root);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function hostRecord(path) {
  normalizedAbsolute(path);
  if (!['/lib/', '/lib64/', '/usr/lib/', '/usr/lib64/'].some((prefix) => path.startsWith(prefix))) {
    throw new Error('runtime_host_root_invalid');
  }
  const resolved = realpathSync(path);
  protectedPath(resolved);
  // Debian's /lib and library SONAME paths are root-owned links. Protect every logical
  // ancestor as well as the final target; root may replace a library, a service actor may not.
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)) {
      throw new Error('runtime_host_custody_invalid');
    }
    if (current === '/') break;
  }
  return { path, resolved, ...fileRecord(resolved) };
}

export function sameRecords(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('runtime_inventory_mismatch');
}
