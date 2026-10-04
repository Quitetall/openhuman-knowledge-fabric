import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/deploy/build-peer-credentials.sh');
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', CC: 'cc' };

it('builds an actual native helper that refuses non-socket stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kf-peer-build-'));
  try {
    const out = join(dir, 'helper');
    const built = spawnSync('bash', [SCRIPT, out], { env, encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    expect(readFileSync(out).subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const refused = spawnSync(out, [], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses an existing output and invalid compiler/static configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kf-peer-build-'));
  try {
    const out = join(dir, 'helper');
    writeFileSync(out, 'keep this fixture');
    expect(spawnSync('bash', [SCRIPT, out], { env }).status).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe('keep this fixture');
    expect(
      spawnSync('bash', [SCRIPT, '--check'], { env: { ...env, CC: 'no-such-compiler' } }).status,
    ).toBe(1);
    expect(
      spawnSync('bash', [SCRIPT, '--check'], { env: { ...env, KF_PEER_CREDENTIALS_STATIC: 'yes' } })
        .status,
    ).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('builds the separate custody atom and refuses an ordinary writable directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kf-custody-build-'));
  try {
    const out = join(dir, 'helper');
    const built = spawnSync('bash', [SCRIPT, '--credential-custody', out], {
      env,
      encoding: 'utf8',
    });
    expect(built.status, built.stderr).toBe(0);
    const refused = spawnSync(out, [dir], { env, encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toBe('credential custody unavailable\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('accepts only the exact service UID ACL and refuses widened or malformed ACLs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kf-custody-acl-'));
  try {
    const out = join(dir, 'acl-test');
    const built = spawnSync(
      'cc',
      [
        '-std=c11',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(ROOT, 'tests/fixtures/credential-custody-acl.c'),
        '-o',
        out,
      ],
      { env, encoding: 'utf8' },
    );
    expect(built.status, built.stderr).toBe(0);
    expect(spawnSync(out, [], { env, encoding: 'utf8' }).status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const hasMusl = spawnSync('musl-gcc', ['--version'], { env, stdio: 'ignore' }).status === 0;
it('matches the custody observer syscall layouts to the installed Linux UAPI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kf-custody-abi-'));
  try {
    const out = join(dir, 'abi-test');
    const built = spawnSync(
      'cc',
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        join(ROOT, 'tests/fixtures/credential-custody-abi.c'),
        '-o',
        out,
      ],
      { env, encoding: 'utf8' },
    );
    expect(built.status, built.stderr).toBe(0);
    expect(spawnSync(out, [], { env }).status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it.skipIf(!hasMusl)(
  'builds the static custody atom and refuses unpinned inspection handles',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'kf-custody-build-'));
    try {
      const out = join(dir, 'helper');
      const built = spawnSync('bash', [SCRIPT, '--credential-custody', out], {
        env: { ...env, CC: 'musl-gcc', KF_PEER_CREDENTIALS_STATIC: '1' },
        encoding: 'utf8',
      });
      expect(built.status, built.stderr).toBe(0);
      const elf = spawnSync('readelf', ['-l', out], { env, encoding: 'utf8' });
      expect(elf.status).toBe(0);
      expect(elf.stdout).not.toContain('INTERP');
      for (const args of [
        [dir],
        ['--inspect', '1101', '1101', dir, 'index-key'],
        ['--inspect', '0', '1101', dir, 'index-key'],
      ]) {
        const refused = spawnSync(out, args, { env, encoding: 'utf8' });
        expect(refused.status).not.toBe(0);
        expect(refused.stdout).toBe('');
        expect(refused.stderr).toBe('credential custody unavailable\n');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
it.skipIf(!hasMusl)('builds a static musl helper without the workstation dynamic loader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kf-peer-build-'));
  try {
    const out = join(dir, 'helper');
    const built = spawnSync('bash', [SCRIPT, out], {
      env: { ...env, CC: 'musl-gcc', KF_PEER_CREDENTIALS_STATIC: '1' },
      encoding: 'utf8',
    });
    expect(built.status, built.stderr).toBe(0);
    const elf = spawnSync('readelf', ['-l', out], { env, encoding: 'utf8' });
    expect(elf.status).toBe(0);
    expect(elf.stdout).not.toContain('INTERP');
    const refused = spawnSync(out, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(refused.status).toBe(1);
    expect(refused.stdout.length).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
