/**
 * `pnpm dogfood:logins` leaves a workstation where the dogfood profile starts with no owner SQL.
 *
 * `local-development.md` had the owner type two `create role` statements in psql, because the
 * login the loader makes (`kf_api_dev`, kf_app + kf_attestor) is refused by BOTH dogfood
 * processes. This proves the replacement end to end against real PostgreSQL:
 *
 *   - the two logins hold exactly one role each, a stray membership is revoked on re-run, and
 *     their connection strings are written 0600;
 *   - the REAL attestor, started through its `dev` entry with nothing but the state directory,
 *     passes its own login check and answers on the socket;
 *   - a dogfood API built on the API login's file passes ITS login check at startup and reports
 *     the attestor and the login ready — which the development login cannot do.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { buildApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { createDogfoodLogins, type DogfoodLogins } from '../../apps/api/src/dogfood/logins.js';
import { startHarness, type Harness } from '../database/harness.js';

const ROOT = join(import.meta.dirname, '..', '..');
const OIDC = {
  OIDC_ISSUER: 'http://localhost:8080/realms/knowledge-fabric',
  OIDC_AUDIENCE: 'knowledge-fabric-api',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/knowledge-fabric/protocol/openid-connect/certs',
};

let h: Harness;
let state: string;
let socket: string;
let logins: DogfoodLogins;
let attestor: ChildProcess | undefined;
let attestorLog = '';

beforeAll(async () => {
  h = await startHarness();
  state = mkdtempSync(join(tmpdir(), 'kf-dogfood-logins-'));
  socket = join(state, 'attestor.sock');
}, 180_000);

afterAll(async () => {
  attestor?.kill('SIGTERM');
  await h?.stop();
  if (state !== undefined) rmSync(state, { recursive: true, force: true });
});

async function memberships(login: string): Promise<string[]> {
  return withTransaction(h.adminPool, async (tx) =>
    (
      await tx.query<{ role: string }>(
        `select g.rolname as role from pg_auth_members m
           join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
          where u.rolname = $1 order by 1`,
        [login],
      )
    ).map((row) => row.role),
  );
}

function healthy(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath: socket, path: '/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

describe('pnpm dogfood:logins', () => {
  it('creates one login per process, each holding exactly its one role, written 0600', async () => {
    // A stale login from an earlier hand procedure, holding what the API must not.
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query(`create role kf_api_dogfood login password 'stale' inherit`);
      await tx.query('grant kf_app, kf_attestor to kf_api_dogfood');
    });

    logins = await createDogfoodLogins(h.adminPool, h.connectionString, { XDG_STATE_HOME: state });

    expect(logins.apiUrlFile).toBe(join(state, 'knowledge-fabric', 'dogfood-api-database-url'));
    expect(logins.attestorUrlFile).toBe(join(state, 'knowledge-fabric', 'attestor-database-url'));
    expect(await memberships('kf_api_dogfood')).toEqual(['kf_app']);
    expect(await memberships('kf_attestor_dev')).toEqual(['kf_attestor']);
    for (const file of [logins.apiUrlFile, logins.attestorUrlFile]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // The stale password is gone: every run re-keys.
      expect(readFileSync(file, 'utf8')).not.toContain(':stale@');
    }
    const api = new URL(readFileSync(logins.apiUrlFile, 'utf8').trim());
    const attest = new URL(readFileSync(logins.attestorUrlFile, 'utf8').trim());
    expect(api.username).toBe('kf_api_dogfood');
    expect(attest.username).toBe('kf_attestor_dev');
    expect(api.password).not.toBe(attest.password);
  });

  it('the real attestor, through its dev entry, accepts its login and answers', async () => {
    attestor = spawn(process.execPath, [join(ROOT, 'apps', 'attestor', 'dist', 'dev.js')], {
      env: {
        PATH: process.env['PATH'] ?? '',
        NODE_ENV: 'development',
        XDG_STATE_HOME: state,
        KF_ATTESTOR_SOCKET: socket,
        ...OIDC,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    attestor.stderr?.on('data', (chunk: Buffer) => (attestorLog += chunk.toString('utf8')));
    const deadline = Date.now() + 20_000;
    let up = false;
    while (!up && Date.now() < deadline && attestor.exitCode === null) {
      up = await healthy();
      if (!up) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(up, attestorLog).toBe(true);
    expect(attestorLog).toContain('"event":"listening"');
    // The password is in a 0600 file and nowhere in the process's own output.
    const password = new URL(readFileSync(logins.attestorUrlFile, 'utf8').trim()).password;
    expect(attestorLog).not.toContain(password);
  }, 30_000);

  it('a dogfood API on its login starts, and reports the attestor and the login ready', async () => {
    const app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        LOG_LEVEL: 'silent',
        DATABASE_URL_FILE: logins.apiUrlFile,
        KF_ATTESTOR_SOCKET: socket,
        ...OIDC,
      }),
    );
    try {
      // onReady refuses a login holding kf_attestor; kf_api_dev would throw here.
      await app.ready();
      const ready = await app.inject({ method: 'GET', url: '/ready' });
      const body = ready.json() as { checks: Record<string, string> };
      expect(body.checks['attestor']).toBe('ok');
      expect(body.checks['login']).toBe('ok');
    } finally {
      await app.close();
    }
  });

  it('the development login is refused by the same startup check (the reason for all this)', async () => {
    const app = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        LOG_LEVEL: 'silent',
        DATABASE_URL: h.developmentDatabaseUrl,
        KF_ATTESTOR_SOCKET: socket,
        ...OIDC,
      }),
    );
    await expect(app.ready()).rejects.toThrow(/refusing to serve/);
    await app.close().catch(() => undefined);
  });
});
