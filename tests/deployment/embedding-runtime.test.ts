import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

// No ML downloads, privileged fixtures or model qualification. Real filesystem
// mutations falsify the inventory; the VM supplies the root-custody integration proof.
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kf-embedding-runtime-test-'));
  roots.push(root);
  chmodSync(root, 0o755);
  mkdirSync(join(root, 'bin'), { mode: 0o755 });
  writeFileSync(join(root, 'bin/python3.13'), 'public interpreter fixture', { mode: 0o755 });
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const modulePath = join(import.meta.dirname, '../../scripts/embedding/runtime-inventory.mjs');
function inspect(root: string, body = 'process.stdout.write(JSON.stringify(treeRecords(root)))') {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { treeRecords, sameRecords, hostRecord } from ${JSON.stringify(modulePath)};
     const root = process.argv[1]; ${body}`,
      root,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
}

it('records exact bytes, modes and directories, excluding only the manifest itself', () => {
  const root = fixture();
  writeFileSync(join(root, 'RUNTIME-CLOSURE.json'), 'manifest excluded', { mode: 0o644 });
  const result = inspect(root);
  expect(result.status, result.stderr).toBe(0);
  const records = JSON.parse(result.stdout);
  expect(records.map((entry: { path: string }) => entry.path)).toEqual(['bin', 'bin/python3.13']);
  expect(records[1]).toMatchObject({ type: 'file', size: 26, mode: 0o755 });
  expect(records[1].sha256).toMatch(/^[0-9a-f]{64}$/);
});

it('inventories literal package data names containing spaces and parentheses', () => {
  const root = fixture();
  writeFileSync(join(root, 'Lorem ipsum.txt'), 'public package data', { mode: 0o644 });
  writeFileSync(join(root, 'script (dev).tmpl'), 'public template', { mode: 0o644 });
  const result = inspect(root);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).map((entry: { path: string }) => entry.path)).toContain(
    'script (dev).tmpl',
  );
});

it.each(['bytes', 'extra file', 'removed file', 'mode', 'directory mode'])(
  'refuses inventory drift in %s',
  (plant) => {
    const root = fixture();
    const baseline = inspect(root);
    expect(baseline.status, baseline.stderr).toBe(0);
    const expected = JSON.parse(baseline.stdout);
    if (plant === 'bytes') writeFileSync(join(root, 'bin/python3.13'), 'changed public fixture');
    if (plant === 'extra file') writeFileSync(join(root, 'extra.py'), 'extra', { mode: 0o644 });
    if (plant === 'removed file') rmSync(join(root, 'bin/python3.13'));
    if (plant === 'mode') chmodSync(join(root, 'bin/python3.13'), 0o644);
    if (plant === 'directory mode') chmodSync(join(root, 'bin'), 0o700);
    const result = inspect(root, `sameRecords(treeRecords(root), ${JSON.stringify(expected)})`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('runtime_inventory_mismatch');
  },
);

it.each(['symlink', 'writable file', 'writable directory'])(
  'refuses unsafe runtime entries: %s',
  (plant) => {
    const root = fixture();
    if (plant === 'symlink') symlinkSync('bin/python3.13', join(root, 'escape'));
    if (plant === 'writable file') chmodSync(join(root, 'bin/python3.13'), 0o777);
    if (plant === 'writable directory') chmodSync(join(root, 'bin'), 0o777);
    const result = inspect(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/runtime_entry_(not_regular|writable)/);
  },
);

it('refuses external files outside declared system library roots', () => {
  const root = fixture();
  const result = inspect(root, 'hostRecord(root + "/bin/python3.13")');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('runtime_host_root_invalid');
});

it('distinguishes inventoried ELF build objects from loadable runtime files', () => {
  const root = fixture();
  const object = Buffer.alloc(18);
  object.write('7f454c46', 0, 'hex');
  object[5] = 1;
  object.writeUInt16LE(1, 16);
  writeFileSync(join(root, 'python.o'), object, { mode: 0o644 });
  const module = join(import.meta.dirname, '../../scripts/embedding/assemble-runtime.mjs');
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {elfKind} from ${JSON.stringify(module)};
     process.stdout.write(String(elfKind(process.argv[1])))`,
      join(root, 'python.o'),
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('1');
  expect(JSON.parse(inspect(root).stdout).map((entry: { path: string }) => entry.path)).toContain(
    'python.o',
  );
});

it('records a real no-DT_NEEDED extension without inventing a host dependency', () => {
  const root = fixture();
  const compile = spawnSync(
    'cc',
    ['-shared', '-nostdlib', '-x', 'c', '-', '-o', join(root, 'empty.so')],
    {
      input: 'int public_fixture(void) { return 1; }\n',
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(compile.status, compile.stderr).toBe(0);
  const module = join(import.meta.dirname, '../../scripts/embedding/assemble-runtime.mjs');
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {treeRecords} from ${JSON.stringify(modulePath)};
     import {nativeDependencies} from ${JSON.stringify(module)};
     process.stdout.write(JSON.stringify(nativeDependencies(process.argv[1], treeRecords(process.argv[1]))))`,
      root,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    native: [{ path: 'empty.so', dependencies: [] }],
    hostFiles: [],
  });
});

it('assembles executable bytes with explicit builder ownership and seals native dependencies', () => {
  const root = fixture();
  // The executable is a public native fixture, not a Python/model compatibility claim.
  const source = join(root, 'public-source');
  mkdirSync(source, { mode: 0o755 });
  copyFileSync(process.execPath, join(source, 'python3.13'));
  mkdirSync(join(source, 'stdlib'), { mode: 0o755 });
  mkdirSync(join(source, 'packages'), { mode: 0o755 });
  writeFileSync(join(source, 'stdlib/fixture.py'), 'public_fixture = True\n', { mode: 0o644 });
  const destination = join(root, 'assembled');
  const module = join(import.meta.dirname, '../../scripts/embedding/assemble-runtime.mjs');
  const result = spawnSync(
    process.execPath,
    [
      module,
      join(source, 'python3.13'),
      join(source, 'stdlib'),
      join(source, 'packages'),
      destination,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  expect(statSync(join(destination, 'bin/python3.13')).uid).toBe(process.getuid?.());
  expect(statSync(join(destination, 'lib/python3.13/fixture.py')).uid).toBe(process.getuid?.());
  const manifest = JSON.parse(readFileSync(join(destination, 'RUNTIME-CLOSURE.json'), 'utf8'));
  expect(manifest.native[0].path).toBe('bin/python3.13');
  expect(manifest.hostFiles.length).toBeGreaterThan(0);
});

it('does not execute model code or accept a malformed pin at the verification CLI', () => {
  const root = fixture();
  const script = join(import.meta.dirname, '../../scripts/embedding/verify-runtime.mjs');
  const result = spawnSync(process.execPath, [script, root, 'invalid-public-pin'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('embedding_runtime_verification_refused\n');
  expect(result.stdout).toBe('');
  expect(readFileSync(join(root, 'bin/python3.13'), 'utf8')).toBe('public interpreter fixture');
});
