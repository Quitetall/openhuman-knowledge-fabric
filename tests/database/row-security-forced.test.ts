import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, withTransaction, type Pool } from '@kf/database';
import { seedFixtures, startHarness, type Harness } from './harness.js';

/**
 * Row security binds the table owner too (KF-SAS-RQ-073, 20260924000200).
 *
 * ENABLE exempts the owner, and PostgreSQL treats any login that INHERITS the owner role as the
 * owner. Until 20260924000200, 76 governed tables only enabled it, so such a login read every
 * tenant at every classification with no context bound; the API refusing to start as one was
 * the only thing in the way.
 */
describe('every table that enables row security forces it', () => {
  let h: Harness;
  let ownerMember: Pool;

  beforeAll(async () => {
    // The default harness owner: not a superuser, BYPASSRLS — what a host's owner must be.
    h = await startHarness();
    await seedFixtures(h.adminPool);
    // A login that inherits the schema owner and has no BYPASSRLS of its own: the API pointed at
    // the wrong credential, or anything else granted the owner role for convenience.
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query(
        `create role kf_owner_member login password 'test-only-not-a-secret' inherit nobypassrls`,
      );
      await tx.query('grant kf_harness_owner to kf_owner_member');
      await tx.query('grant connect on database kf_test to kf_owner_member');
    });
    const uri = new URL(h.connectionString);
    uri.username = 'kf_owner_member';
    uri.password = 'test-only-not-a-secret';
    ownerMember = createPool({ connectionString: uri.toString(), maxConnections: 1 });
  }, 240_000);

  afterAll(async () => {
    await ownerMember?.end();
    await h?.stop();
  });

  it('leaves no table in any schema enabling row security without forcing it', async () => {
    const unforced = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ table: string }>(
        `select c.oid::regclass::text as table
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p') and c.relrowsecurity and not c.relforcerowsecurity
            and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'
          order by 1`,
      ),
    );
    expect(unforced, 'these tables exempt anyone who inherits their owner').toEqual([]);
  });

  it('holds a login that inherits the owner to the policies, with no context bound', async () => {
    // org.person and work tables were among the unforced; people exist after the fixtures.
    const seen = await withTransaction(ownerMember, (tx) =>
      tx.one<{ people: number; roles: number; actions: number }>(
        `select (select count(*) from org.person)::int as people,
                (select count(*) from org.role_assignment)::int as roles,
                (select count(*) from core.action)::int as actions`,
      ),
    );
    expect(seen).toEqual({ people: 0, roles: 0, actions: 0 });
    // The same rows exist; the refusal is the policy, not an empty table.
    const present = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ people: number }>('select count(*)::int as people from org.person'),
    );
    expect(present.people).toBeGreaterThan(0);
  });

  it('still lets the owner itself read past them, which the definer seams depend on', async () => {
    const owner = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ bypasses: boolean }>(
        `select r.rolbypassrls as bypasses from pg_class c join pg_roles r on r.oid = c.relowner
          where c.oid = 'org.person'::regclass`,
      ),
    );
    expect(owner.bypasses, 'the harness owner must be what a host owner is: BYPASSRLS').toBe(true);
  });

  it('names why the ops tables carry no row security at all', async () => {
    // They are operational facts about the installation, not governed records. If one grows an
    // organization column it needs row security, and this list is where that gets noticed.
    const opsWithTenant = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ table: string }>(
        `select c.oid::regclass::text as table
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'ops' and c.relkind = 'r' and not c.relrowsecurity
            and exists (select 1 from pg_attribute a
                         where a.attrelid = c.oid and a.attname = 'organization_id'
                           and not a.attisdropped)`,
      ),
    );
    expect(opsWithTenant).toEqual([]);
  });
});
