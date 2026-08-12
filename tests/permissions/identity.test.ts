/**
 * Identity: the provider says who, the database says what.
 *
 * Tokens here are real — signed with a local key pair and verified through the same `jose`
 * path production uses, with the key set injected so nothing reaches the network. A test that
 * stubbed verification would prove the wiring and nothing about the check.
 *
 * The load-bearing test is `refuses a role the token claims but the person does not hold`. If
 * that ever passes by accident, authority has moved to the identity provider, and an
 * administrator there can grant themselves approval rights over a device design without
 * touching this system.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from 'jose';
import { createLocalJWKSet } from 'jose';
import { withTransaction } from '@kf/database';
import {
  IdentityRejected,
  TokenVerifier,
  linkIdentity,
  resolveCaller,
  revokeIdentity,
} from '@kf/authorization';
import { registerActionRoutes } from '../../apps/api/src/routes/actions.js';
import {
  bindContext,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

const ISSUER = 'https://id.openhuman.invalid/realms/openhuman';
const AUDIENCE = 'knowledge-fabric';

let h: Harness;
let f: Fixtures;
let verifier: TokenVerifier;
let privateKey: KeyObject;
let publicJwk: JWK;
let linkId: string;

/** A token as the identity provider would mint it. */
async function token(
  claims: {
    subject?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    /** Role claims, included ONLY to prove they are ignored. */
    roles?: string[];
    /** Seconds since the person actually authenticated. Absent means the token has no auth_time. */
    authenticatedSecondsAgo?: number;
    /** Authentication methods, as `amr`. */
    methods?: string[];
  } = {},
): Promise<string> {
  const jwt = new SignJWT({
    ...(claims.roles === undefined ? {} : { realm_access: { roles: claims.roles } }),
    ...(claims.authenticatedSecondsAgo === undefined
      ? {}
      : { auth_time: Math.floor(Date.now() / 1000) - claims.authenticatedSecondsAgo }),
    ...(claims.methods === undefined ? {} : { amr: claims.methods }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(claims.subject ?? 'auth0|reviewer')
    .setIssuer(claims.issuer ?? ISSUER)
    .setAudience(claims.audience ?? AUDIENCE)
    .setIssuedAt();
  return jwt.setExpirationTime(claims.expiresIn ?? '5m').sign(privateKey);
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);

  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey as KeyObject;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };

  // A LOCAL key set, so the verifier never touches the network — the same code path a remote
  // set would take, minus the fetch.
  verifier = new TokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://unused.invalid/jwks' },
    createLocalJWKSet({ keys: [publicJwk] }),
  );

  linkId = await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    return linkIdentity(tx, {
      issuer: ISSUER,
      subject: 'auth0|reviewer',
      personId: f.reviewerId,
      providerLabel: 'Reviewer',
      linkedBy: f.performerId,
    });
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

const request = (over: Partial<Parameters<typeof resolveCaller>[2]> = {}) => ({
  token: '',
  actingRoleId: f.reviewerRoleId,
  organizationId: f.organizationId,
  maxClassification: 'restricted',
  ...over,
});

describe('a valid token becomes a caller', () => {
  it('maps the subject to the person, and the role comes from the database', async () => {
    const caller = await resolveCaller(h.adminPool, verifier, request({ token: await token() }));
    expect(caller.actorId).toBe(f.reviewerId);
    expect(caller.actingRoleId).toBe(f.reviewerRoleId);
    expect(caller.subject).toBe('auth0|reviewer');
  });
});

describe('what the token cannot do', () => {
  it('IGNORES role claims entirely', async () => {
    // The load-bearing test. A token asserting every role in the system still only gets the
    // role the DATABASE says this person holds — and asking for one they do not hold is
    // refused, no matter what the token says.
    const loaded = await token({
      roles: ['technical_authority', 'finance_approver', 'system_administrator'],
    });

    const caller = await resolveCaller(h.adminPool, verifier, request({ token: loaded }));
    expect(caller.actingRoleId).toBe(f.reviewerRoleId);

    // The performer's role assignment belongs to a different person. Claiming it fails.
    const err = await resolveCaller(
      h.adminPool,
      verifier,
      request({ token: loaded, actingRoleId: f.performerRoleId }),
    ).catch((e: unknown) => e);
    // Checked, not cast. A cast would have passed on any thrown value at all, including a
    // plain Error from something unrelated going wrong on the way.
    expect(err).toBeInstanceOf(IdentityRejected);
    expect((err as IdentityRejected).failure).toBe('role_not_held');
  });

  it('refuses a subject nobody has linked', async () => {
    // A valid token for somebody this system has never heard of. Auto-provisioning here would
    // let anyone the provider accepts become an actor, and the actor list is who can be held
    // responsible.
    const err = await resolveCaller(
      h.adminPool,
      verifier,
      request({ token: await token({ subject: 'auth0|stranger' }) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityRejected);
    expect((err as IdentityRejected).failure).toBe('unknown_subject');
  });

  it('refuses a token from another issuer', async () => {
    const err = await resolveCaller(
      h.adminPool,
      verifier,
      request({ token: await token({ issuer: 'https://evil.invalid/' }) }),
    ).catch((e: unknown) => e as IdentityRejected);
    expect((err as IdentityRejected).failure).toBe('invalid_token');
  });

  it('refuses a token minted for another service by the SAME issuer', async () => {
    // Valid, signed, unexpired, from the right provider — and not for us. Accepting it would
    // let any service in the estate act here on a user's behalf.
    const err = await resolveCaller(
      h.adminPool,
      verifier,
      request({ token: await token({ audience: 'some-other-service' }) }),
    ).catch((e: unknown) => e as IdentityRejected);
    expect((err as IdentityRejected).failure).toBe('invalid_token');
  });

  it('refuses an expired token', async () => {
    const err = await resolveCaller(
      h.adminPool,
      verifier,
      request({ token: await token({ expiresIn: '-1h' }) }),
    ).catch((e: unknown) => e as IdentityRejected);
    expect((err as IdentityRejected).failure).toBe('invalid_token');
  });

  it('refuses a token signed by a different key', async () => {
    const other = await generateKeyPair('RS256', { extractable: true });
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject('auth0|reviewer')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(other.privateKey);

    const err = await resolveCaller(h.adminPool, verifier, request({ token: forged })).catch(
      (e: unknown) => e as IdentityRejected,
    );
    expect((err as IdentityRejected).failure).toBe('invalid_token');
  });

  it('collapses every token failure into one code', async () => {
    // Distinguishing "expired" from "bad signature" from "wrong audience" tells an attacker
    // which part of a forged token to fix next.
    const failures = await Promise.all(
      [
        token({ issuer: 'https://evil.invalid/' }),
        token({ audience: 'elsewhere' }),
        token({ expiresIn: '-1h' }),
      ].map(async (t) =>
        resolveCaller(h.adminPool, verifier, request({ token: await t })).catch(
          (e: unknown) => (e as IdentityRejected).failure,
        ),
      ),
    );
    expect(new Set(failures)).toEqual(new Set(['invalid_token']));
  });

  it('requires the acting role to be stated, rather than picking one', async () => {
    // A person may hold several. Choosing for them decides an authority question on their
    // behalf, and the audit trail would record a role they never selected.
    const err = await resolveCaller(
      h.adminPool,
      verifier,
      request({ token: await token(), actingRoleId: '' }),
    ).catch((e: unknown) => e as IdentityRejected);
    expect((err as IdentityRejected).failure).toBe('no_role_requested');
  });
});

describe('organization scope', () => {
  it('refuses a valid token that claims an organization the person is not in', async () => {
    // The review asked whether an authenticated person could read another organization's data
    // by stating its id. Checked here rather than reasoned about.
    // Both pools. h.pool is the UNPRIVILEGED role the API actually uses; h.adminPool is the
    // container superuser, which bypasses row-level security even with FORCE RLS — so a
    // property that held only on adminPool would be a property that does not hold at all,
    // and one that held only on h.pool would be relying on RLS for something RLS is not.
    for (const [name, pool] of [
      ['unprivileged', h.pool],
      ['superuser', h.adminPool],
    ] as const) {
      const err = await resolveCaller(
        pool,
        verifier,
        request({
          token: await token(),
          organizationId: '01930000-0000-7000-8000-0000000f0000',
        }),
      ).catch((e: unknown) => e);
      expect(err, `as ${name}`).toBeInstanceOf(IdentityRejected);
      expect((err as IdentityRejected).failure, `as ${name}`).toBe('role_not_held');
    }
  });
});

describe('classification narrows rather than widens', () => {
  it('a lower clearance returns a subset, not a superset', async () => {
    // The comment in the route claims an unstated clearance narrows what is visible. That
    // relies on the database comparing ranks in the direction everyone assumes, and an
    // inverted comparison would turn the safe default into an escalation. Checked, not
    // assumed.
    const counts = await Promise.all(
      ['internal', 'restricted'].map(async (clearance) =>
        withTransaction(h.pool, async (tx) => {
          await tx.query('select core.set_access_context($1, $2)', [f.organizationId, clearance]);
          const row = await tx.one<{ n: string }>('select count(*)::text as n from core.object');
          return Number(row.n);
        }),
      ),
    );
    const [atInternal, atRestricted] = counts as [number, number];
    expect(atInternal).toBeLessThanOrEqual(atRestricted);
  });
});

describe('revocation', () => {
  it('takes effect immediately, not at the next token expiry', async () => {
    const good = await token();
    expect((await resolveCaller(h.adminPool, verifier, request({ token: good }))).actorId).toBe(
      f.reviewerId,
    );

    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await revokeIdentity(tx, linkId);
    });
    try {
      // The SAME still-valid token. Authority is checked where it lives, so a token minted
      // before revocation cannot outlive it.
      const err = await resolveCaller(h.adminPool, verifier, request({ token: good })).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(IdentityRejected);
      expect((err as IdentityRejected).failure).toBe('revoked_identity');
    } finally {
      await withTransaction(h.adminPool, async (tx) =>
        tx.query('update org.external_identity set revoked_at = null where id = $1', [linkId]),
      );
    }
  });

  it('keeps the revoked row — who could sign in as whom is a fact', async () => {
    const rows = await withTransaction(h.adminPool, async (tx) =>
      tx.query<{ id: string }>('select id from org.external_identity where id = $1', [linkId]),
    );
    expect(rows).toHaveLength(1);
  });
});

describe('over HTTP', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerActionRoutes(app, {
      pool: h.adminPool,
      verifier,
      trustHeaders: false,
      execute: async () => ({
        actionId: '019ff000-0000-7000-8000-000000000001',
        replayed: false,
        objectIds: [],
        auditDigest: '0'.repeat(64),
      }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts a bearer token', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/accept_decision',
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-kf-acting-role': f.reviewerRoleId,
        'x-kf-organization': f.organizationId,
        'x-kf-classification': 'restricted',
      },
      payload: { idempotencyKey: 'identity-http-0001', targetIds: [] },
    });
    expect(r.statusCode).toBe(201);
  });

  it('IGNORES identity headers once a verifier exists — no fallback', async () => {
    // A fallback is a bypass that activates exactly when the provider is unreachable. With a
    // verifier configured there is no header path at all, so the old development headers get
    // a 401 rather than a session.
    const r = await app.inject({
      method: 'POST',
      url: '/actions/accept_decision',
      headers: {
        'x-kf-actor': f.reviewerId,
        'x-kf-acting-role': f.reviewerRoleId,
        'x-kf-organization': f.organizationId,
      },
      payload: { idempotencyKey: 'identity-http-0002', targetIds: [] },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ error: 'no_token' });
  });

  /** Headers for a caller who is entitled to act; only the token varies. */
  const asReviewer = (bearer: string) => ({
    authorization: `Bearer ${bearer}`,
    'x-kf-acting-role': f.reviewerRoleId,
    'x-kf-organization': f.organizationId,
    'x-kf-classification': 'restricted',
  });

  describe('step-up on the actions that are hardest to undo', () => {
    it('refuses to authorize a payment on a session nobody re-proved', async () => {
      // A valid token, a real person, a role they genuinely hold — and eight hours since they
      // last typed anything. Everything about this request is legitimate except the one thing
      // that matters for moving money.
      const r = await app.inject({
        method: 'POST',
        url: '/actions/authorize_payment',
        headers: asReviewer(await token({ authenticatedSecondsAgo: 8 * 3600, methods: ['mfa'] })),
        payload: { idempotencyKey: 'step-up-0001', targetIds: [] },
      });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({
        error: 'step_up_required',
        detail: { failure: 'authentication_too_old' },
      });
      // The standard challenge, so the caller's client knows to send them back to the
      // provider with max_age rather than simply giving up.
      expect(r.headers['www-authenticate']).toMatch(/insufficient_user_authentication/);
      expect(r.headers['www-authenticate']).toMatch(/max_age=900/);
    });

    it('refuses when the provider never said when they authenticated', async () => {
      // Fails closed. A provider that does not report auth_time cannot prove the session is
      // recent, and "cannot prove" has to mean no — otherwise the control evaporates for
      // exactly the providers least able to enforce it.
      const r = await app.inject({
        method: 'POST',
        url: '/actions/authorize_payment',
        headers: asReviewer(await token({ methods: ['mfa'] })),
        payload: { idempotencyKey: 'step-up-0002', targetIds: [] },
      });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ detail: { failure: 'authentication_age_unknown' } });
    });

    it('refuses a recent password-only authentication for a payment', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/actions/authorize_payment',
        headers: asReviewer(await token({ authenticatedSecondsAgo: 30, methods: ['pwd'] })),
        payload: { idempotencyKey: 'step-up-0003', targetIds: [] },
      });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ detail: { failure: 'method_insufficient' } });
    });

    it('allows it once they have re-authenticated properly', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/actions/authorize_payment',
        headers: asReviewer(await token({ authenticatedSecondsAgo: 30, methods: ['mfa', 'pwd'] })),
        payload: { idempotencyKey: 'step-up-0004', targetIds: [] },
      });
      expect(r.statusCode).toBe(201);
    });

    it('asks only for recency where recency is what is at stake', async () => {
      // Closing a CAPA withdraws a control. It does not need a hardware token; it needs the
      // person to still be at the keyboard.
      const r = await app.inject({
        method: 'POST',
        url: '/actions/close_capa',
        headers: asReviewer(await token({ authenticatedSecondsAgo: 60, methods: ['pwd'] })),
        payload: { idempotencyKey: 'step-up-0005', targetIds: [] },
      });
      expect(r.statusCode).toBe(201);
    });

    it('leaves everyday work alone', async () => {
      // A policy that covers everything gets switched off. Accepting a decision is something
      // people do dozens of times a day, and it carries no step-up requirement — proven here
      // with a token that would fail every policy in DEFAULT_STEP_UP.
      const r = await app.inject({
        method: 'POST',
        url: '/actions/accept_decision',
        headers: asReviewer(await token()),
        payload: { idempotencyKey: 'step-up-0006', targetIds: [] },
      });
      expect(r.statusCode).toBe(201);
    });

    it('checks step-up BEFORE attempting the action', async () => {
      // Order matters twice over: a refused request must not have started a transaction, and
      // it must not have consumed the idempotency key — otherwise re-sending after a
      // successful re-authentication would replay the refusal.
      const key = 'step-up-0007';
      const stale = await app.inject({
        method: 'POST',
        url: '/actions/approve_invoice',
        headers: asReviewer(await token({ authenticatedSecondsAgo: 7200 })),
        payload: { idempotencyKey: key, targetIds: [] },
      });
      expect(stale.statusCode).toBe(401);

      const fresh = await app.inject({
        method: 'POST',
        url: '/actions/approve_invoice',
        headers: asReviewer(await token({ authenticatedSecondsAgo: 10 })),
        payload: { idempotencyKey: key, targetIds: [] },
      });
      expect(fresh.statusCode).toBe(201);
    });
  });

  it('returns a code the caller can act on, without saying what would have worked', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/accept_decision',
      headers: {
        authorization: `Bearer ${await token({ subject: 'auth0|stranger' })}`,
        'x-kf-acting-role': f.reviewerRoleId,
        'x-kf-organization': f.organizationId,
      },
      payload: { idempotencyKey: 'identity-http-0003', targetIds: [] },
    });
    expect(r.statusCode).toBe(401);
    // Enough to know whether to re-authenticate or ask for access; not enough to enumerate.
    expect(r.json()).toMatchObject({ error: 'unknown_subject' });
    expect(JSON.stringify(r.json())).not.toContain(f.reviewerId);
  });
});
