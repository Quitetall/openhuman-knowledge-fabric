/** Execute the actual pre-seal mode normalization on restrictive public fixtures.
 * This does not build a release or prove ownership, byte identity or commissioning.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

function normalize(): { root: string; outside: string } {
  const parent = mkdtempSync(join(tmpdir(), 'kf-release-modes-'));
  made.push(parent);
  const root = join(parent, 'release');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  chmodSync(root, 0o700);
  chmodSync(join(root, 'runtime'), 0o700);
  for (const [name, mode] of [
    ['runtime/index.js', 0o600],
    ['runtime/run.sh', 0o700],
    ['runtime/writable.json', 0o666],
  ] as const) {
    const path = join(root, name);
    writeFileSync(path, 'public fixture\n');
    chmodSync(path, mode);
  }
  const outside = join(parent, 'outside');
  writeFileSync(outside, 'public outside fixture\n');
  chmodSync(outside, 0o600);
  symlinkSync(outside, join(root, 'outside-link'));
  const recipe = readFileSync(join(ROOT, 'scripts/deploy/build-release.sh'), 'utf8');
  const start = recipe.indexOf('echo "== normalise modes before sealing =="');
  const end = recipe.indexOf('echo "== seal =="', start);
  expect(start, 'normalization entry point disappeared').toBeGreaterThan(-1);
  expect(end, 'seal entry point disappeared').toBeGreaterThan(start);
  execFileSync('/usr/bin/bash', [
    '-c',
    `set -euo pipefail; release_root="$1"\n${recipe.slice(start, end)}`,
    'fixture',
    root,
  ]);
  return { root, outside };
}

describe('sealed release modes are independent of the build umask', () => {
  it('declares public build creation modes before installation and the gate', () => {
    const recipe = readFileSync(join(ROOT, 'scripts/deploy/build-release.sh'), 'utf8');
    const start = recipe.indexOf('set -euo pipefail');
    const end = recipe.indexOf('source_root=', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const mode = execFileSync(
      '/usr/bin/bash',
      ['-c', `umask 077\n${recipe.slice(start, end)}\numask`],
      { encoding: 'utf8' },
    );
    expect(mode.trim()).toBe('0022');
  });

  it('makes generated runtime bytes readable to separate service identities', () => {
    const { root } = normalize();
    expect(statSync(join(root, 'runtime/index.js')).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, 'runtime/writable.json')).mode & 0o777).toBe(0o644);
  });

  it('preserves executable intent for all service identities without making data executable', () => {
    const { root } = normalize();
    expect(statSync(join(root, 'runtime/run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'runtime/index.js')).mode & 0o111).toBe(0);
  });

  it('makes directories traversable and skips symlinks and their external targets', () => {
    const { root, outside } = normalize();
    expect(statSync(root).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'runtime')).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(root, 'outside-link')).isSymbolicLink()).toBe(true);
    expect(statSync(outside).mode & 0o777).toBe(0o600);
  });
});
