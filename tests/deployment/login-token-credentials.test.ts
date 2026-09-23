/**
 * scripts/deploy/login-token.sh takes a password from a prompt or an owner-only file, never
 * from the environment or the command line.
 *
 * `KF_LOGIN_PASSWORD=... login-token.sh` puts the password in shell history, and an exported
 * variable is inherited by every child of that shell. The real script runs here, because a
 * reimplementation would pass while the shell was broken.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'deploy', 'login-token.sh');
const work = mkdtempSync(join(tmpdir(), 'kf-login-token-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(env: Record<string, string>): { status: number | null; stderr: string } {
  // setsid: a new session has no controlling terminal, so /dev/tty cannot be opened and the
  // script can never block on a prompt, whatever terminal the test runner was started from.
  const result = spawnSync('setsid', ['-w', 'bash', SCRIPT, 'someone', join(work, 'token')], {
    // No issuer, so a run that gets past the password stops at the next check without touching
    // the network. stdin is closed and there is no terminal, so nothing can prompt.
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

describe('login-token.sh password intake', () => {
  it('refuses a password supplied in the environment', () => {
    const result = run({ KF_LOGIN_PASSWORD: 'correct horse battery staple' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/KF_LOGIN_PASSWORD is no longer read/);
  });

  it('refuses a password file other users can read', () => {
    const file = join(work, 'readable');
    writeFileSync(file, 'correct horse battery staple\n', { mode: 0o644 });
    const result = run({ KF_LOGIN_PASSWORD_FILE: file });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/chmod 600/);
  });

  it('accepts an owner-only password file and goes on to the next check', () => {
    const file = join(work, 'owner-only');
    writeFileSync(file, 'correct horse battery staple\n', { mode: 0o600 });
    const result = run({ KF_LOGIN_PASSWORD_FILE: file });
    expect(result.stderr).toMatch(/KF_OIDC_ISSUER \(or OIDC_ISSUER\) is required/);
  });

  it('refuses to guess when there is neither a file nor a terminal', () => {
    const result = run({});
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no terminal to prompt on/);
  });
});
