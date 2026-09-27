import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, withTransaction, type Pool, type Principal, type Tx } from '@kf/database';
import { runDeclareServiceActor } from '../../apps/api/src/admin/declare-service-actor.js';
import {
  aYearFromNow,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * The database binds a person only on an attestation that they are present (20260924001000).
 *
 * Before this migration `core.bind_principal` believed any real person the application named,
 * so a compromised API could act as anyone with their real authority (threat model T2, open
 * item 6). Every refusal below binds through a pool that registers NO attestation issuer — a
 * bare application login, exactly what the API connects as — because the harness pool would
 * fetch a valid attestation on its own and hide the refusal under test.
 */
describe('the application binds a person only on an attestation', () => {
  let h: Harness;
  let f: Fixtures;
  let other: Fixtures;
  /** `kf_app` and nothing else, with no issuer registered: the production API's login. */
  let app: Pool;
  let steward: { personId: string; roleAssignmentId: string };

  const loginPool = async (name: string, groups: readonly string[]): Promise<Pool> => {
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query(`create role ${name} login password 'test-only-not-a-secret' inherit`);
      for (const group of groups) await tx.query(`grant ${group} to ${name}`);
      await tx.query(`grant connect on database kf_test to ${name}`);
    });
    const uri = new URL(h.connectionString);
    uri.username = name;
    uri.password = 'test-only-not-a-secret';
    return createPool({ connectionString: uri.toString(), maxConnections: 2 });
  };

  beforeAll(async () => {
    h = await startHarness();
    f = await seedFixtures(h.adminPool);
    other = await seedFixtures(h.adminPool, { auditClearance: false });
    app = await loginPool('kf_bare_app_login', ['kf_app']);
    const declared = await runDeclareServiceActor(h.adminPool, {
      validTo: aYearFromNow(),
      organizationId: f.organizationId,
      name: 'storage-steward',
      roleId: 'performer',
      classification: 'restricted',
      declaredBy: f.reviewerId,
      reason: 'replicates and re-verifies artifact copies on a timer',
    });
    steward = { personId: declared.personId, roleAssignmentId: declared.roleAssignmentId };
  }, 240_000);

  afterAll(async () => {
    await app?.end();
    await h?.stop();
  });

  const performer = (maxClassification = 'restricted'): Principal => ({
    actorId: f.performerId,
    actingRoleId: f.performerRoleId,
    organizationId: f.organizationId,
    maxClassification,
  });

  const bind = (
    pool: Pool,
    principal: Principal,
    attestation: string | null,
    requested = principal.maxClassification,
  ): Promise<string> =>
    withTransaction(pool, async (tx: Tx) => {
      const row = await tx.one<{ c: string }>(
        'select core.bind_principal($1, $2, $3, $4, $5) as c',
        [
          principal.actorId,
          principal.actingRoleId,
          principal.organizationId,
          requested,
          attestation,
        ],
      );
      return row.c;
    });

  describe('refusals', () => {
    it('refuses a bind with no attestation at all', async () => {
      await expect(bind(app, performer(), null)).rejects.toThrow(/no current attestation/);
    });

    it('refuses the four-argument call the previous API made', async () => {
      await expect(
        withTransaction(app, (tx) =>
          tx.query('select core.bind_principal($1, $2, $3, $4)', [
            f.performerId,
            f.performerRoleId,
            f.organizationId,
            'restricted',
          ]),
        ),
      ).rejects.toThrow(/no current attestation/);
    });

    it('refuses a forged attestation and a malformed one', async () => {
      await expect(bind(app, performer(), randomBytes(32).toString('hex'))).rejects.toThrow(
        /no current attestation/,
      );
      await expect(bind(app, performer(), 'not-hex')).rejects.toThrow(/no current attestation/);
    });

    it('refuses an expired attestation', async () => {
      const attestation = await h.attest(performer());
      await withTransaction(h.adminPool, (tx) =>
        tx.query(
          `update core.principal_attestation
              set issued_at = now() - interval '10 minutes',
                  expires_at = now() - interval '9 minutes 30 seconds'
            where digest = sha256(decode($1, 'hex'))`,
          [attestation],
        ),
      );
      await expect(bind(app, performer(), attestation)).rejects.toThrow(/no current attestation/);
    });

    it("refuses another person's attestation", async () => {
      const reviewers = await h.attest({
        actorId: f.reviewerId,
        actingRoleId: f.reviewerRoleId,
        organizationId: f.organizationId,
        maxClassification: 'restricted',
      });
      await expect(bind(app, performer(), reviewers)).rejects.toThrow(/no current attestation/);
    });

    it('refuses an attestation from another tenant, even for the same kind of role', async () => {
      const elsewhere = await h.attest({
        actorId: other.performerId,
        actingRoleId: other.performerRoleId,
        organizationId: other.organizationId,
        maxClassification: 'restricted',
      });
      await expect(bind(app, performer(), elsewhere)).rejects.toThrow(/no current attestation/);
    });

    it('refuses a ceiling above the attested one', async () => {
      const internal = await h.attest(performer('internal'));
      await expect(bind(app, performer(), internal, 'restricted')).rejects.toThrow(
        /no current attestation/,
      );
    });
  });

  describe('acceptance', () => {
    it('binds on a valid attestation, and at any ceiling at or below it', async () => {
      const attestation = await h.attest(performer('confidential'));
      expect(await bind(app, performer(), attestation, 'confidential')).toBe('confidential');
      expect(await bind(app, performer(), attestation, 'public')).toBe('public');
    });

    it('is reusable by every transaction of the request until it expires', async () => {
      const attestation = await h.attest(performer());
      for (let i = 0; i < 3; i += 1) {
        expect(await bind(app, performer(), attestation)).toBe('restricted');
      }
    });

    it('expires at the earlier of the token expiry and one minute', async () => {
      const soon = new Date(Date.now() + 20_000);
      const [long, short] = await Promise.all([
        withTransaction(h.attestorPool, (tx) =>
          tx.one<{ a: string }>('select core.issue_attestation($1, $2, $3, $4, null) as a', [
            f.performerId,
            f.performerRoleId,
            f.organizationId,
            'restricted',
          ]),
        ),
        withTransaction(h.attestorPool, (tx) =>
          tx.one<{ a: string }>('select core.issue_attestation($1, $2, $3, $4, $5) as a', [
            f.performerId,
            f.performerRoleId,
            f.organizationId,
            'restricted',
            soon,
          ]),
        ),
      ]);
      const lifetimes = await withTransaction(h.adminPool, (tx) =>
        tx.query<{ seconds: number }>(
          `select extract(epoch from expires_at - issued_at)::float8 as seconds
             from core.principal_attestation
            where digest in (sha256(decode($1, 'hex')), sha256(decode($2, 'hex')))
            order by 1 desc`,
          [long.a, short.a],
        ),
      );
      expect(lifetimes[0]!.seconds).toBeCloseTo(60, 0);
      expect(lifetimes[1]!.seconds).toBeLessThan(21);
    });

    it('stores only a digest, never the attestation itself', async () => {
      const attestation = await h.attest(performer());
      const stored = await withTransaction(h.adminPool, (tx) =>
        tx.query(`select 1 from core.principal_attestation where encode(digest, 'hex') = $1`, [
          attestation,
        ]),
      );
      expect(stored).toHaveLength(0);
    });

    it('leaves administrator binds as they were', async () => {
      expect(await bind(h.adminPool, performer(), null)).toBe('restricted');
    });
  });

  describe('who may attest', () => {
    it('the application login cannot issue an attestation', async () => {
      const err = await withTransaction(app, (tx) =>
        tx.query('select core.issue_attestation($1, $2, $3, $4, null)', [
          f.performerId,
          f.performerRoleId,
          f.organizationId,
          'restricted',
        ]),
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: '42501' });
    });

    it('nor read or write the attestations', async () => {
      for (const sql of [
        'select count(*) from core.principal_attestation',
        `insert into core.principal_attestation
           (digest, person_id, assignment_id, organization_id, ceiling, expires_at)
         values (sha256('x'), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                 'public', now() + interval '30 seconds')`,
      ]) {
        const err = await withTransaction(app, (tx) => tx.query(sql)).catch((e: unknown) => e);
        expect(err, sql).toMatchObject({ code: '42501' });
      }
    });

    it('the attestor login cannot bind anybody', async () => {
      const attestation = await h.attest(performer());
      const err = await bind(h.attestorPool, performer(), attestation).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: '42501' });
    });

    it('refuses to attest a token that has already expired', async () => {
      await expect(
        withTransaction(h.attestorPool, (tx) =>
          tx.query('select core.issue_attestation($1, $2, $3, $4, $5)', [
            f.performerId,
            f.performerRoleId,
            f.organizationId,
            'restricted',
            new Date(Date.now() - 1_000),
          ]),
        ),
      ).rejects.toThrow(/already expired/);
    });

    it('refuses to attest a role the person does not hold, or above their clearance', async () => {
      await expect(h.attest({ ...performer(), actingRoleId: f.reviewerRoleId })).rejects.toThrow(
        /not held live/,
      );
      await expect(
        h.attest({ ...performer(), organizationId: other.organizationId }),
      ).rejects.toThrow(/not held live/);
    });

    it('refuses to attest a service actor, which is never present', async () => {
      await expect(
        h.attest({
          actorId: steward.personId,
          actingRoleId: steward.roleAssignmentId,
          organizationId: f.organizationId,
          maxClassification: 'internal',
        }),
      ).rejects.toThrow(/service actor/);
    });
  });

  describe('the service-actor login', () => {
    const stewardPrincipal = (): Principal => ({
      actorId: steward.personId,
      actingRoleId: steward.roleAssignmentId,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });

    it('binds a declared service actor on its own credential', async () => {
      expect(await bind(h.storagePool, stewardPrincipal(), null)).toBe('restricted');
    });

    it('binds nobody else, even with a valid attestation', async () => {
      const attestation = await h.attest(performer());
      await expect(bind(h.storagePool, performer(), attestation)).rejects.toThrow(
        /binds only service actors/,
      );
    });

    it('is the ONLY application login that binds a service actor unattested', async () => {
      await expect(bind(app, stewardPrincipal(), null)).rejects.toThrow(/no current attestation/);
    });
  });
});
