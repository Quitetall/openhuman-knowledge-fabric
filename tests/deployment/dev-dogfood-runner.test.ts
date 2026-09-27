/**
 * `pnpm dev:dogfood` starts kf-attestor FIRST, waits for it to answer on its socket, and only then
 * starts the API and the web app with the same socket. Run for real, with `pnpm` replaced on PATH
 * by a stand-in that records each invocation and, for the attestor, actually listens.
 */

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'kf-dev-dogfood-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Records argv, time and the env that matters; the attestor call serves /health until killed. */
const FAKE_PNPM = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { createServer } = require('node:http');
const record = (extra) => appendFileSync(process.env.FAKE_LOG, JSON.stringify({
  args: process.argv.slice(2),
  at: Date.now(),
  socket: process.env.KF_ATTESTOR_SOCKET,
  databaseUrlFile: process.env.DATABASE_URL_FILE,
  profile: process.env.KF_DEPLOYMENT_PROFILE,
  owner: process.env.DATABASE_OWNER_URL,
  ...extra,
}) + '\\n');
if (process.argv.includes('@kf/attestor')) {
  // Slow to come up, as a real attestor that builds first is.
  setTimeout(() => {
    createServer((_req, res) => { res.writeHead(200); res.end('{"status":"ok"}'); })
      .listen(process.env.KF_ATTESTOR_SOCKET, () => record({ listening: true }));
  }, 600);
  record({ listening: false });
  process.on('SIGTERM', () => process.exit(0));
} else {
  record({});
}
`;

describe('pnpm dev:dogfood', () => {
  it('starts the attestor, waits for it, then the API and web on the same socket', async () => {
    const bin = join(dir, 'bin');
    const state = join(dir, 'state');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(state, 'knowledge-fabric'), { recursive: true });
    writeFileSync(join(bin, 'pnpm'), FAKE_PNPM);
    chmodSync(join(bin, 'pnpm'), 0o755);
    for (const name of ['dogfood-api-database-url', 'attestor-database-url']) {
      writeFileSync(join(state, 'knowledge-fabric', name), 'postgres://x@localhost/kf\n', {
        mode: 0o600,
      });
    }
    const log = join(dir, 'log.jsonl');
    const socket = join(dir, 'attestor.sock');

    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, 'scripts', 'dev-dogfood.mjs')], {
        cwd: ROOT,
        env: {
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          FAKE_LOG: log,
          XDG_STATE_HOME: state,
          KF_ATTESTOR_SOCKET: socket,
          OIDC_ISSUER: 'http://localhost:8080/realms/knowledge-fabric',
          OIDC_AUDIENCE: 'knowledge-fabric-api',
          OIDC_JWKS_URI:
            'http://localhost:8080/realms/knowledge-fabric/protocol/openid-connect/certs',
          KF_WEB_OIDC_ISSUER: 'http://localhost:8080/realms/knowledge-fabric',
          KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
          KF_WEB_OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
          KF_WEB_SESSION_SECRET: 'x'.repeat(44),
          DATABASE_OWNER_URL: 'postgres://kf_owner:dev-only-not-a-secret@localhost:5432/kf',
        },
        stdio: 'ignore',
      });
      child.on('exit', (exitCode) => resolve(exitCode));
    });

    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const attestorStart = calls.find((c) => (c['args'] as string[]).includes('@kf/attestor'));
    const listening = calls.find((c) => c['listening'] === true);
    const apps = calls.find((c) => (c['args'] as string[]).includes('@kf/api'));

    expect(code).toBe(0);
    expect(attestorStart?.['socket']).toBe(socket);
    expect(attestorStart?.['databaseUrlFile']).toBe(
      join(state, 'knowledge-fabric', 'attestor-database-url'),
    );
    expect(apps, 'the API and web app were never started').toBeDefined();
    // Not merely started after the attestor: started after it ANSWERED.
    expect(apps!['at'] as number).toBeGreaterThanOrEqual(listening!['at'] as number);
    expect(apps!['args']).toEqual([
      '--parallel',
      '--filter',
      '@kf/api',
      '--filter',
      '@kf/web',
      'dev',
    ]);
    expect(apps!['socket']).toBe(socket);
    expect(apps!['profile']).toBe('dogfood');
    expect(apps!['databaseUrlFile']).toBe(
      join(state, 'knowledge-fabric', 'dogfood-api-database-url'),
    );
    for (const call of calls) expect(call['owner']).toBeUndefined();
  }, 30_000);
});
