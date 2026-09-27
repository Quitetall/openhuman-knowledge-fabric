import { describe, expect, it } from 'vitest';
import { planDogfoodDev } from './dev-dogfood.js';

const ENV: NodeJS.ProcessEnv = {
  XDG_STATE_HOME: '/state',
  XDG_RUNTIME_DIR: '/run/user/1000',
  OIDC_ISSUER: 'http://localhost:8080/realms/knowledge-fabric',
  OIDC_AUDIENCE: 'knowledge-fabric-api',
  OIDC_JWKS_URI: 'http://localhost:8080/realms/knowledge-fabric/protocol/openid-connect/certs',
  KF_WEB_OIDC_ISSUER: 'http://localhost:8080/realms/knowledge-fabric',
  KF_WEB_OIDC_CLIENT_ID: 'knowledge-fabric-web',
  KF_WEB_OIDC_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  KF_WEB_SESSION_SECRET: 'x'.repeat(44),
  // What .env carries for the development profile: none of it may reach a dogfood process.
  KF_DEPLOYMENT_PROFILE: 'development',
  DATABASE_URL_FILE: '/state/knowledge-fabric/dev-database-url',
  DATABASE_OWNER_URL: 'postgres://kf_owner:dev-only-not-a-secret@localhost:5432/kf',
  // The owner-tier commands read this first (RQ-151), so it is the same credential.
  DATABASE_OWNER_URL_FILE: '/state/knowledge-fabric/owner-database-url',
};
const everything = (): boolean => true;

describe('planDogfoodDev', () => {
  it('gives the attestor its own login and the socket, and the API its own login and the same socket', () => {
    const plan = planDogfoodDev(ENV, everything);
    if (!plan.ok) throw new Error(plan.problems.join('\n'));
    expect(plan.socket).toBe('/run/user/1000/kf-attestor.sock');
    expect(plan.attestor.args).toEqual(['--filter', '@kf/attestor', 'dev']);
    expect(plan.attestor.env['DATABASE_URL_FILE']).toBe(
      '/state/knowledge-fabric/attestor-database-url',
    );
    expect(plan.attestor.env['KF_ATTESTOR_SOCKET']).toBe(plan.socket);
    expect(plan.apps.args).toEqual([
      '--parallel',
      '--filter',
      '@kf/api',
      '--filter',
      '@kf/web',
      'dev',
    ]);
    expect(plan.apps.env['DATABASE_URL_FILE']).toBe(
      '/state/knowledge-fabric/dogfood-api-database-url',
    );
    expect(plan.apps.env['KF_ATTESTOR_SOCKET']).toBe(plan.socket);
    expect(plan.apps.env['KF_DEPLOYMENT_PROFILE']).toBe('dogfood');
  });

  it('hands no process the owner credential or the development login', () => {
    const plan = planDogfoodDev(ENV, everything);
    if (!plan.ok) throw new Error('unexpected refusal');
    for (const env of [plan.attestor.env, plan.apps.env]) {
      expect(env['DATABASE_OWNER_URL']).toBeUndefined();
      expect(env['DATABASE_OWNER_URL_FILE']).toBeUndefined();
      expect(env['DATABASE_URL']).toBeUndefined();
      expect(env['DATABASE_URL_FILE']).not.toContain('dev-database-url');
    }
  });

  it('refuses, naming the one command, when the logins were never created', () => {
    const plan = planDogfoodDev(ENV, () => false);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.problems).toHaveLength(2);
    expect(plan.problems.join('\n')).toMatch(/pnpm dogfood:logins/);
  });

  it('refuses without an identity provider for the API and the web app', () => {
    const plan = planDogfoodDev(
      { ...ENV, OIDC_AUDIENCE: '', KF_WEB_SESSION_SECRET: undefined },
      everything,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.problems.join('\n')).toMatch(/OIDC_AUDIENCE not set/);
    expect(plan.problems.join('\n')).toMatch(/KF_WEB_SESSION_SECRET not set/);
  });

  it('keeps a stated socket path', () => {
    const plan = planDogfoodDev({ ...ENV, KF_ATTESTOR_SOCKET: '/tmp/a.sock' }, everything);
    expect(plan.ok && plan.socket).toBe('/tmp/a.sock');
  });
});
