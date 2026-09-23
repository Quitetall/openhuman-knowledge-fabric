/**
 * The API refuses to serve through a login row-level security cannot bind.
 *
 * Every tenant and classification boundary is a policy. A superuser, a BYPASSRLS role and the
 * table owner all walk past policies, so pointing DATABASE_URL at the wrong credential file
 * disabled every one of them while /ready stayed green. Each case here is a real login against
 * a real PostgreSQL, because "the check reads pg_roles correctly" is the claim under test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { buildApp } from '../../apps/api/src/app.js';
import type { ApiConfig } from '../../apps/api/src/config.js';
import { startHarness, type Harness } from '../database/harness.js';

let h: Harness;
const PASSWORD = 'test-only-not-a-secret';

function urlFor(login: string): string {
  const uri = new URL(h.connectionString);
  uri.username = login;
  uri.password = PASSWORD;
  return uri.toString();
}

function configFor(databaseUrl: string): ApiConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseUrl,
    environment: 'test',
    deploymentProfile: 'development',
    tlsTerminatedUpstream: false,
    identity: undefined,
  };
}

beforeAll(async () => {
  h = await startHarness();
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`create role kf_bypass_login login bypassrls password '${PASSWORD}'`);
    // Not the owner itself: a login that INHERITS from it, which is how a migrator is shaped.
    await tx.query(`create role kf_owner_member_login login password '${PASSWORD}'`);
    await tx.query('grant kf_harness_owner to kf_owner_member_login');
    // The harness owner also has BYPASSRLS, so the case above is caught twice. Ownership alone
    // needs an owner with no other attribute: FORCE is per table and an owner can turn it off.
    await tx.query('create role kf_plain_owner nologin');
    await tx.query('create table core.login_privilege_probe (id int)');
    await tx.query('alter table core.login_privilege_probe owner to kf_plain_owner');
    await tx.query(`create role kf_plain_owner_login login password '${PASSWORD}'`);
    await tx.query('grant kf_plain_owner to kf_plain_owner_login');
    await tx.query(
      'grant connect on database kf_test to kf_bypass_login, kf_owner_member_login, ' +
        'kf_plain_owner_login',
    );
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('database login privilege at API startup', () => {
  it('serves through an application login and says so on /ready', async () => {
    const app = await buildApp(configFor(urlFor('kf_app_login')));
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.json()).toMatchObject({ checks: { login: 'ok' } });
    await app.close();
  });

  it.each([
    ['a superuser', () => h.connectionString],
    ['a BYPASSRLS login', () => urlFor('kf_bypass_login')],
    ['a member of the schema owner', () => urlFor('kf_owner_member_login')],
    ['a member of a table owner with no other privilege', () => urlFor('kf_plain_owner_login')],
  ])('refuses to become ready as %s', async (_label, url) => {
    const app = await buildApp(configFor(url()));
    await expect(app.ready()).rejects.toThrow(/refusing to serve: database login/);
    await app.close().catch(() => undefined);
  });
});
