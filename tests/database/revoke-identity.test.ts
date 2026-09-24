import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { linkIdentity, resolveCaller, type TokenVerifier } from '@kf/authorization';
import { withTransaction } from '@kf/database';
import { runRevokeIdentityCommand } from '../../apps/api/src/admin/commands.js';
import {
  BOOTSTRAP_IDENTITY,
  runBootstrap,
} from '../../apps/api/src/admin/bootstrap-organization.js';
import {
  IdentityAlreadyRevoked,
  runRevokeIdentity,
} from '../../apps/api/src/admin/revoke-identity.js';
import { bindContext, seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

/**
 * `kf revoke-identity`: withdrawing a provider account's link to a person is an owner-tier act,
 * recorded as grant-authority records the link — an action row with the operator's reason, an
 * audit event extending the chain, and `revoked_at` set, in one transaction. Against a real
 * database, because what it proves is that the next sign-in as that account is refused.
 */

const ISSUER = 'https://id.openhuman.invalid/realms/openhuman';

let h: Harness;
let f: Fixtures;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

async function link(subject: string, personId: string): Promise<string> {
  return withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    return linkIdentity(tx, { issuer: ISSUER, subject, personId, linkedBy: f.performerId });
  });
}

/** A verifier that accepts any token as `subject`: the link, not the token, is under test. */
function verifierFor(subject: string): TokenVerifier {
  return {
    verify: async () => ({ sub: subject, iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 60 }),
  } as unknown as TokenVerifier;
}

async function counts(personId: string): Promise<{ actions: number; attestations: number }> {
  return withTransaction(h.adminPool, async (tx) => {
    const actions = await tx.one<{ n: string }>(
      `select count(*)::text as n from core.action
        where action_type = 'revoke_external_identity' and $1 = any(target_ids)`,
      [personId],
    );
    const attestations = await tx.one<{ n: string }>(
      'select count(*)::text as n from core.principal_attestation where person_id = $1',
      [personId],
    );
    return { actions: Number(actions.n), attestations: Number(attestations.n) };
  });
}

const sink = (): Writable & { text: () => string } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString('utf8'));
      done();
    },
  }) as Writable & { text: () => string };
  stream.text = () => chunks.join('');
  return stream;
};

describe('kf revoke-identity', () => {
  it('revokes by issuer and subject, recorded as an act with its reason and audit event', async () => {
    const identityId = await link('auth0|leaver', f.reviewerId);
    // The person is present right now: an attestation outstanding from a request in flight.
    await h.attest({
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      organizationId: f.organizationId,
      maxClassification: 'internal',
    });
    expect((await counts(f.reviewerId)).attestations).toBeGreaterThan(0);

    const result = await runRevokeIdentity(h.adminPool, {
      target: { issuer: ISSUER, subject: 'auth0|leaver' },
      revokedBy: f.performerId,
      reason: 'left the company 2026-09-24',
    });

    expect(result.identityId).toBe(identityId);
    expect(result.personId).toBe(f.reviewerId);
    expect(result.actingRoleId).toBe(f.performerRoleId);
    expect(result.attestationsWithdrawn).toBeGreaterThan(0);
    expect((await counts(f.reviewerId)).attestations).toBe(0);

    await withTransaction(h.adminPool, async (tx) => {
      const row = await tx.one<{ revoked_at: Date | null; person_id: string }>(
        'select revoked_at, person_id from org.external_identity where id = $1',
        [identityId],
      );
      // Revoked, never deleted, never repointed.
      expect(row.revoked_at).not.toBeNull();
      expect(row.person_id).toBe(f.reviewerId);

      const action = await tx.one<{
        action_type: string;
        actor_id: string;
        acting_role_id: string;
        reason: string;
        target_ids: string[];
        parameters: Record<string, unknown>;
        organization_id: string;
      }>(
        `select action_type, actor_id, acting_role_id, reason, target_ids, parameters,
                organization_id
           from core.action where id = $1`,
        [result.actionId],
      );
      expect(action).toMatchObject({
        action_type: 'revoke_external_identity',
        actor_id: f.performerId,
        acting_role_id: f.performerRoleId,
        reason: 'left the company 2026-09-24',
        target_ids: [f.reviewerId],
        organization_id: f.organizationId,
        parameters: { identity_id: identityId, issuer: ISSUER, subject: 'auth0|leaver' },
      });

      const event = await tx.one<{ seq: string; prev_digest: string; digest: string }>(
        'select seq::text, prev_digest, digest from core.audit_event where action_id = $1',
        [result.actionId],
      );
      expect(event.digest).toBe(result.auditDigest);
      const previous = await tx.one<{ digest: string }>(
        'select digest from core.audit_event where seq < $1 order by seq desc limit 1',
        [event.seq],
      );
      // Extends the chain: its predecessor is whatever head came before it.
      expect(event.prev_digest).toBe(previous.digest);
    });

    // The next sign-in as that account is refused.
    const refused = await resolveCaller(h.attestorPool, verifierFor('auth0|leaver'), {
      token: 'any',
      actingRoleId: f.reviewerRoleId,
      organizationId: f.organizationId,
      maxClassification: 'internal',
    }).catch((e: unknown) => e);
    expect((refused as { failure?: string }).failure).toBe('revoked_identity');
  });

  it('refuses a link already revoked, and records nothing', async () => {
    const identityId = await link('auth0|twice', f.performerId);
    await runRevokeIdentity(h.adminPool, {
      target: { identityId },
      revokedBy: f.reviewerId,
      reason: 'account compromised',
    });
    const before = await counts(f.performerId);
    const err = await runRevokeIdentity(h.adminPool, {
      target: { issuer: ISSUER, subject: 'auth0|twice' },
      revokedBy: f.reviewerId,
      reason: 'again',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityAlreadyRevoked);
    expect((err as Error).message).toMatch(/already revoked .* Nothing was written/);
    expect(await counts(f.performerId)).toEqual(before);
  });

  it('refuses a link that does not exist', async () => {
    await expect(
      runRevokeIdentity(h.adminPool, {
        target: { issuer: ISSUER, subject: 'auth0|nobody' },
        revokedBy: f.reviewerId,
        reason: 'no such account',
      }),
    ).rejects.toThrow(/no identity link for/);
  });

  it('does not stop an emergency revocation when the revoker holds no role there', async () => {
    const identityId = await link('auth0|emergency', f.reviewerId);
    // The founder of another organization: a real person with no role assignment in this one.
    const outsider = await runBootstrap(h.adminPool, {
      legalName: `Outside operator's company (${randomUUID()})`,
      personName: 'Outside operator',
      organizationKind: 'company',
      organizationId: '',
    });
    const result = await runRevokeIdentity(h.adminPool, {
      target: { identityId },
      revokedBy: outsider.personId,
      reason: 'suspected takeover, revoked before anyone with a role could be reached',
    });
    // Recorded, and recorded honestly: no role was exercised, so none is claimed.
    expect(result.actingRoleId).toBeUndefined();
    const action = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ acting_role_id: string; actor_id: string }>(
        'select acting_role_id, actor_id from core.action where id = $1',
        [result.actionId],
      ),
    );
    expect(action).toEqual({ acting_role_id: BOOTSTRAP_IDENTITY, actor_id: outsider.personId });
  });

  it('the command refuses a revocation with no reason before touching the database', async () => {
    await link('auth0|no-reason', f.reviewerId);
    const out = sink();
    const err = sink();
    const code = await runRevokeIdentityCommand(
      ['--issuer', ISSUER, '--subject', 'auth0|no-reason', '--revoked-by', f.performerId],
      { DATABASE_OWNER_URL: h.connectionString },
      out,
      err,
    );
    expect(code).toBe(2);
    expect(err.text()).toMatch(/no --reason given/);
    const live = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ revoked_at: Date | null }>(
        'select revoked_at from org.external_identity where subject = $1',
        ['auth0|no-reason'],
      ),
    );
    expect(live.revoked_at).toBeNull();
  });

  it('the command revokes, prints the act, and refuses a second run', async () => {
    const out = sink();
    const err = sink();
    const argv = [
      '--issuer',
      ISSUER,
      '--subject',
      'auth0|no-reason',
      '--revoked-by',
      f.performerId,
      '--reason=link made in error',
    ];
    expect(
      await runRevokeIdentityCommand(argv, { DATABASE_OWNER_URL: h.connectionString }, out, err),
    ).toBe(0);
    expect(out.text()).toMatch(/identity revoked, and recorded/);
    expect(out.text()).toMatch(/revoke_external_identity/);
    const again = sink();
    expect(
      await runRevokeIdentityCommand(
        argv,
        { DATABASE_OWNER_URL: h.connectionString },
        sink(),
        again,
      ),
    ).toBe(1);
    expect(again.text()).toMatch(/already revoked/);
  });
});
