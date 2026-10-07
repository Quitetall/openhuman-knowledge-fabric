/**
 * The drill's object-store verifier runs when it is reached through /opt/kf.
 *
 * /opt/kf is a symbolic link to the installed release, and restore-verify.sh calls
 * `$ROOT/apps/kf-storage/dist/verify-object-store.js` through it. Node loads a module by its real
 * path, so a main-module check that compared `import.meta.url` with argv[1] as given never fired
 * on a host: the verifier exited 0 having measured nothing. Misuse through a symlinked release
 * must instead be answered with the usage and 64 — which only happens if `main` ran.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

describe('verify-object-store.js through a symlinked release', () => {
  it('runs its main and answers misuse with 64', () => {
    const work = mkdtempSync(join(tmpdir(), 'kf-symlinked-release-'));
    try {
      const link = join(work, 'kf');
      symlinkSync(ROOT, link);
      const r = spawnSync(
        process.execPath,
        [join(link, 'apps', 'kf-storage', 'dist', 'verify-object-store.js')],
        { encoding: 'utf8' },
      );
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(64);
      expect(r.stderr).toContain('usage:');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
