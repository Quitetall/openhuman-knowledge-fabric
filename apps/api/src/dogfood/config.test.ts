import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNotPrivateHost,
  devDatabaseUrlFile,
  generateAppPassword,
  writeOwnerOnly,
} from './config.js';

describe('dogfood loader credentials', () => {
  it('refuses to run where /etc/kf marks a provisioned host', async () => {
    const provisioned = await mkdtemp(join(tmpdir(), 'kf-etc-'));
    expect(() => assertNotPrivateHost(provisioned)).toThrow(/provisioned host/);
    expect(() => assertNotPrivateHost(join(provisioned, 'absent'))).not.toThrow();
  });

  it('mints a different, unguessable password on every run', () => {
    // It was the published constant `dev-only-not-a-secret`, for a login that inherits kf_app.
    const first = generateAppPassword();
    const second = generateAppPassword();
    expect(first).not.toBe(second);
    expect(first).not.toBe('dev-only-not-a-secret');
    expect(first.length).toBeGreaterThanOrEqual(40);
  });

  it('writes the connection string owner-only, even over a world-readable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kf-dev-url-'));
    const path = join(dir, 'nested', 'dev-database-url');
    await writeOwnerOnly(path, 'first');
    await writeFile(path, 'loose', { mode: 0o644 });
    await writeOwnerOnly(path, 'postgres://kf_api_dev:x@localhost/kf');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe('postgres://kf_api_dev:x@localhost/kf\n');
  });

  it('keeps the file outside the repository by default', () => {
    expect(devDatabaseUrlFile({ XDG_STATE_HOME: '/state' })).toBe(
      '/state/knowledge-fabric/dev-database-url',
    );
    expect(devDatabaseUrlFile({ KF_DEV_DATABASE_URL_FILE: '/tmp/x' })).toBe('/tmp/x');
  });
});
