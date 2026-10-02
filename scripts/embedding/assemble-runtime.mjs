#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FORMAT,
  MANIFEST,
  digest,
  hostRecord,
  normalizedAbsolute,
  treeRecords,
} from './runtime-inventory.mjs';

function copyTree(source, destination) {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(destination, { mode: 0o755 });
    for (const name of readdirSync(source).sort()) {
      // Bytecode is generated host cache, never part of this interpreter's inputs.
      if (name === '__pycache__' || name.endsWith('.pyc')) continue;
      copyTree(join(source, name), join(destination, name));
    }
  } else {
    const resolved = stat.isSymbolicLink() ? realpathSync(source) : source;
    if (!lstatSync(resolved).isFile()) throw new Error('runtime_source_not_regular');
    copyFileSync(resolved, destination);
    // Ownership is not inferred from a privileged caller or a successful copy.
    // Normalize explicitly; startup verification independently requires root custody.
    chownSync(destination, process.getuid(), process.getgid());
    chmodSync(destination, (stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
  }
}

export function elfKind(path) {
  const descriptor = openSync(path, 'r');
  try {
    const header = Buffer.alloc(18);
    if (
      readSync(descriptor, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 4).toString('hex') !== '7f454c46'
    )
      return 0;
    if (header[5] === 1) return header.readUInt16LE(16);
    if (header[5] === 2) return header.readUInt16BE(16);
    throw new Error('runtime_elf_header_invalid');
  } finally {
    closeSync(descriptor);
  }
}

export function nativeDependencies(root, entries) {
  const host = new Set();
  const native = [];
  for (const entry of entries) {
    if (entry.type !== 'file' || ![2, 3].includes(elfKind(join(root, entry.path)))) continue;
    const result = spawnSync('/usr/bin/ldd', [join(root, entry.path)], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error || result.status !== 0 || output.includes('not found')) {
      throw new Error('runtime_native_dependency_unresolved');
    }
    const dependencies = new Set();
    if (output.trim() === 'statically linked') {
      // Python extensions may expose unresolved Python symbols but have no DT_NEEDED
      // entries. Require the ELF declaration, not just ldd's prose, before accepting zero.
      const declaration = spawnSync('/usr/bin/readelf', ['--dynamic', join(root, entry.path)], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      });
      if (
        declaration.error ||
        declaration.status !== 0 ||
        declaration.stderr ||
        declaration.stdout.includes('(NEEDED)')
      ) {
        throw new Error('runtime_native_static_unproved');
      }
      native.push({ path: entry.path, dependencies: [] });
      continue;
    }
    for (const line of output.split('\n').filter((line) => line.trim())) {
      if (/^\s*linux-vdso\.so/.test(line)) continue;
      const match = line.match(/(?:=>\s*)?(\/[A-Za-z0-9._/+@=-]+)\s+\(0x[0-9a-f]+\)/);
      if (!match) throw new Error('runtime_native_output_invalid');
      const path = normalizedAbsolute(normalize(match[1]));
      if (path.startsWith(`${root}/`)) {
        const relative = path.slice(root.length + 1);
        if (!entries.some((record) => record.type === 'file' && record.path === relative)) {
          throw new Error('runtime_native_internal_unlisted');
        }
        dependencies.add(`runtime:${relative}`);
      } else {
        host.add(path);
        dependencies.add(`host:${path}`);
      }
    }
    native.push({ path: entry.path, dependencies: [...dependencies].sort() });
  }
  return { native, hostFiles: [...host].sort().map(hostRecord) };
}

/** Offline assembly only; source inputs must already be trusted public build artifacts. */
export function assembleRuntime(python, stdlib, packages, destination) {
  for (const path of [python, stdlib, packages, destination]) normalizedAbsolute(path);
  if (existsSync(destination) || !lstatSync(dirname(destination)).isDirectory()) {
    throw new Error('runtime_destination_invalid');
  }
  if (basename(python) !== 'python3.13' || ![2, 3].includes(elfKind(realpathSync(python)))) {
    throw new Error('runtime_interpreter_invalid');
  }
  mkdirSync(destination, { mode: 0o755 });
  mkdirSync(join(destination, 'bin'), { mode: 0o755 });
  copyTree(realpathSync(python), join(destination, 'bin/python3.13'));
  mkdirSync(join(destination, 'lib'), { mode: 0o755 });
  copyTree(stdlib, join(destination, 'lib/python3.13'));
  const site = join(destination, 'lib/python3.13/site-packages');
  if (existsSync(site)) throw new Error('runtime_stdlib_contains_packages');
  copyTree(packages, site);
  const entries = treeRecords(destination);
  const closure = nativeDependencies(destination, entries);
  const manifest = { format: FORMAT, python: 'bin/python3.13', entries, ...closure };
  const bytes = `${JSON.stringify(manifest)}\n`;
  writeFileSync(join(destination, MANIFEST), bytes, { mode: 0o644, flag: 'wx' });
  return digest(bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 6) throw new Error('runtime_usage_invalid');
    process.stdout.write(`${assembleRuntime(...process.argv.slice(2))}\n`);
  } catch {
    // Inputs are public artifacts, but arbitrary exception/path contents still do not enter logs.
    process.stderr.write('embedding_runtime_assembly_refused\n');
    process.exitCode = 1;
  }
}
