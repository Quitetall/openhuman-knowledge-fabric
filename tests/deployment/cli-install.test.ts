/** Actual offline workspace bin relinking; not dependency supply-chain or cloud qualification. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

it('a repeated frozen install exposes a newly added workspace CLI without a dependency change', () => {
  const work = mkdtempSync(join(tmpdir(), 'kf-cli-install-'));
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', CI: 'true' };
  const run = (args: string[]) =>
    spawnSync('pnpm', args, { cwd: work, env, encoding: 'utf8', timeout: 30_000 });
  try {
    mkdirSync(join(work, 'commands'));
    writeFileSync(join(work, '.npmrc'), readFileSync(join(ROOT, '.npmrc')));
    const relinking =
      /^optimisticRepeatInstall:.*$/m.exec(
        readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8'),
      )?.[0] ?? '';
    writeFileSync(join(work, 'pnpm-workspace.yaml'), `packages:\n  - 'commands'\n${relinking}\n`);
    writeFileSync(
      join(work, 'package.json'),
      JSON.stringify({
        name: 'public-cli-install-fixture',
        private: true,
        dependencies: { 'public-cli-commands': 'workspace:*' },
      }),
    );
    const manifest = {
      name: 'public-cli-commands',
      version: '1.0.0',
      bin: { 'existing-command': './command.cjs' },
    };
    const packagePath = join(work, 'commands/package.json');
    writeFileSync(packagePath, JSON.stringify(manifest));
    writeFileSync(
      join(work, 'commands/command.cjs'),
      '#!/usr/bin/env node\nprocess.stdout.write("public-fixture-command\\n");\n',
    );
    const flags = ['--offline', '--ignore-scripts', '--store-dir', join(work, 'store')];
    const first = run(['install', '--no-frozen-lockfile', ...flags]);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const lock = readFileSync(join(work, 'pnpm-lock.yaml'), 'utf8');
    writeFileSync(
      packagePath,
      JSON.stringify({
        ...manifest,
        bin: { ...manifest.bin, 'new-workspace-command': './command.cjs' },
      }),
    );
    const repeated = run(['install', '--frozen-lockfile', ...flags]);
    expect(repeated.status, repeated.stdout + repeated.stderr).toBe(0);
    expect(readFileSync(join(work, 'pnpm-lock.yaml'), 'utf8')).toBe(lock);
    const invoked = run(['exec', 'new-workspace-command']);
    expect(invoked.status, invoked.stdout + invoked.stderr).toBe(0);
    expect(invoked.stdout).toBe('public-fixture-command\n');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
