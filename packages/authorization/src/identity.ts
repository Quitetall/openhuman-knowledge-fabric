/**
 * Turning an access token into a caller.
 *
 * The identity provider answers one question — who is this — and the database answers the
 * rest. A token that carried roles would move the authority decision to Keycloak, where an
 * administrator could grant themselves technical authority over a device design without
 * touching this system, and where the record of who could approve what would live somewhere
 * with no audit chain and no separation of duty.
 *
 * So role claims are not consulted. Not "not consulted yet" — there is no code path here that
 * reads them, and adding one would be the change worth arguing about.
 *
 * What is verified, in order, before a token becomes a caller:
 *
 *   signature   against the issuer's published keys, fetched over TLS and cached
 *   issuer      exactly the configured one
 *   audience    exactly the configured one — a token minted for another service is not a
 *               token for this one, even from the same provider
 *   expiry      with a small clock tolerance, no more
 *   subject     mapped to a live person in `org.external_identity`
 *   role        held by that person, live, in `org.role_assignment`
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Pool, Tx } from '@kf/database';
import { withTransaction } from '@kf/database';
import { authenticationEvent, type AuthenticationEvent } from './step-up.js';

export interface Caller {
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly organizationId: string;
  readonly maxClassification: string;
  /** Who the provider said this was, for logging. Never used to decide anything. */
  readonly subject: string;
  /**
   * How and when they authenticated.
   *
   * The one thing the provider IS authoritative about: the authentication event happened
   * there and nowhere else. Roles are refused because authority belongs to this database;
   * this is not the same mistake in the other direction.
   */
  readonly authentication: AuthenticationEvent;
}

export type IdentityFailure =
  | 'no_token'
  | 'invalid_token'
  | 'unknown_subject'
  | 'revoked_identity'
  | 'role_not_held'
  | 'no_role_requested';

export class IdentityRejected extends Error {
  readonly failure: IdentityFailure;

  constructor(failure: IdentityFailure, message: string) {
    super(message);
    this.name = 'IdentityRejected';
    this.failure = failure;
  }
}

export interface IdentityConfig {
  readonly issuer: string;
  readonly audience: string;
  /** Where the issuer publishes its signing keys. */
  readonly jwksUri: string;
  /** Seconds of clock skew tolerated. Small on purpose. */
  readonly clockToleranceSeconds?: number;
}

/**
 * Verifies tokens against one issuer.
 *
 * The key set is fetched lazily and cached by `jose`, which also handles rotation: a key id
 * it has not seen triggers a refetch, so rotating at the provider does not need a deployment
 * here. It is created ONCE per verifier rather than per request — a JWKS fetch on every call
 * would make the identity provider a hard dependency of every single request, and a slow one.
 */
export class TokenVerifier {
  readonly #config: IdentityConfig;
  readonly #keys: JWTVerifyGetKey;
  readonly #onFailure: ((reason: string) => void) | undefined;

  constructor(
    config: IdentityConfig,
    keys?: JWTVerifyGetKey,
    onFailure?: (reason: string) => void,
  ) {
    this.#config = config;
    // Callers collapse every token failure into one code, which is right for the caller and
    // unhelpful for an operator: a provider outage and a forged token look identical in the
    // logs. This hook lets the server record the real reason without returning it.
    this.#onFailure = onFailure;
    // Injectable so tests can verify against a local key without standing up a provider —
    // and so nothing in the test path can accidentally reach the network.
    this.#keys = keys ?? createRemoteJWKSet(new URL(config.jwksUri));
  }

  async verify(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.#keys, {
        issuer: this.#config.issuer,
        // Audience is checked, not merely present. A token minted for another service by the
        // same provider is a valid token and not one for us; accepting it would let any
        // service in the estate act here on a user's behalf.
        audience: this.#config.audience,
        clockTolerance: this.#config.clockToleranceSeconds ?? 30,
      });
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        throw new Error('token has no finite expiration');
      }
      return payload;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'not verifiable';
      this.#onFailure?.(reason);
      // One failure for every reason. Distinguishing "expired" from "bad signature" from
      // "wrong audience" tells an attacker which part of a forged token to fix next.
      throw new IdentityRejected('invalid_token', 'token rejected');
    }
  }
}

export interface CallerRequest {
  /** The raw bearer token. */
  readonly token: string;
  /** Which of the actor's roles they are acting under, for this request. */
  readonly actingRoleId: string;
  readonly organizationId: string;
  readonly maxClassification: string;
}

/**
 * Resolve a verified token into a caller.
 *
 * Every step after verification reads the DATABASE. The token contributes a subject and
 * nothing else.
 */
export async function resolveCaller(
  pool: Pool,
  verifier: TokenVerifier,
  request: CallerRequest,
): Promise<Caller> {
  if (request.token.trim() === '') {
    throw new IdentityRejected('no_token', 'no bearer token was supplied');
  }
  if (request.actingRoleId.trim() === '') {
    // Which role somebody is acting under is a choice, not a default. A person may hold
    // several, and picking one for them decides an authority question on their behalf.
    throw new IdentityRejected(
      'no_role_requested',
      'the acting role must be stated; holding a role is not the same as acting under it',
    );
  }

  const payload = await verifier.verify(request.token);
  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  if (subject === '') {
    throw new IdentityRejected('invalid_token', 'token carries no subject');
  }
  const issuer = typeof payload.iss === 'string' ? payload.iss : '';

  const authentication = authenticationEvent(payload);

  return withTransaction(pool, async (tx) => {
    // Scope first, as every read in this system does.
    await tx.query('select core.set_access_context($1, $2)', [
      request.organizationId,
      request.maxClassification,
    ]);
    return resolveIn(tx, { issuer, subject, authentication, ...request });
  });
}

/** The database half, separated so it can be tested without a token. */
export async function resolveIn(
  tx: Tx,
  request: {
    readonly issuer: string;
    readonly subject: string;
    readonly actingRoleId: string;
    readonly organizationId: string;
    readonly maxClassification: string;
    readonly authentication?: AuthenticationEvent;
  },
): Promise<Caller> {
  const link = await tx.maybeOne<{ person_id: string; revoked_at: Date | null }>(
    `select person_id, revoked_at from org.external_identity
      where issuer = $1 and subject = $2
      -- A live link wins over a revoked one whatever the insertion order. Ordering on
      -- linked_at alone would let a revoked row inserted later mask a live one, refusing
      -- somebody who is perfectly entitled to sign in.
      --
      -- Revoked rows are still SELECTED rather than filtered out, so a revoked identity is
      -- told it was revoked instead of being told it never existed.
      order by (revoked_at is null) desc, linked_at desc
      limit 1`,
    [request.issuer, request.subject],
  );

  if (link === undefined) {
    // A valid token for somebody this system has never heard of. Refused rather than
    // auto-provisioned: creating a person on first sign-in would let anyone the provider
    // accepts become an actor here, and the actor list is who can be held responsible.
    throw new IdentityRejected(
      'unknown_subject',
      'this identity is not linked to a person in this system',
    );
  }
  if (link.revoked_at !== null) {
    throw new IdentityRejected('revoked_identity', 'this identity link has been revoked');
  }

  const holds = await tx.maybeOne<{ id: string }>(
    `select ra.id
       from org.role_assignment ra
       join core.object o on o.id = ra.id
      where ra.id = $1
        and ra.subject_id = $2
        and o.lifecycle_state = 'active'
        -- The role must belong to the ORGANIZATION the caller claims to be acting within.
        --
        -- This clause is the organization boundary, and it is written here rather than left
        -- to row-level security on purpose. Without it the check still passed on the
        -- application role — RLS hides another organization's role assignment — and FAILED on
        -- a superuser connection, which bypasses RLS even with FORCE ROW LEVEL SECURITY. So
        -- the boundary held only for callers connecting as exactly the right role, and any
        -- worker, migration tool or admin script resolving a caller would silently have lost
        -- it. An authorization property that depends on which database role happens to be
        -- connected is not a property.
        and o.organization_id = $3
        -- Checked at the moment of use, not at sign-in. A role that expired mid-session is
        -- expired; a token minted an hour ago cannot outlive the authority behind it.
        and ra.valid_from <= now()
        and (ra.valid_to is null or ra.valid_to > now())`,
    [request.actingRoleId, link.person_id, request.organizationId],
  );
  if (holds === undefined) {
    throw new IdentityRejected(
      'role_not_held',
      'the acting role is not held by this person, or is not currently valid',
    );
  }

  return {
    actorId: link.person_id,
    actingRoleId: request.actingRoleId,
    organizationId: request.organizationId,
    maxClassification: request.maxClassification,
    subject: request.subject,
    // Absent when resolveIn is called directly without a token. Every field inside is
    // undefined, which every step-up policy treats as a failure — the fail-closed direction.
    authentication: request.authentication ?? {
      authenticatedAt: undefined,
      assuranceLevel: undefined,
      methods: [],
    },
  };
}

/**
 * Link an identity provider subject to a person.
 *
 * Deliberately not automatic. Somebody decides that this account is that person, and that
 * decision is recorded with who made it.
 */
export async function linkIdentity(
  tx: Tx,
  link: {
    readonly issuer: string;
    readonly subject: string;
    readonly personId: string;
    readonly providerLabel?: string;
    readonly linkedBy: string;
  },
): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `insert into org.external_identity (issuer, subject, person_id, provider_label, linked_by)
     values ($1,$2,$3,$4,$5) returning id`,
    [link.issuer, link.subject, link.personId, link.providerLabel ?? null, link.linkedBy],
  );
  return row.id;
}

/** Withdraw a link. The row stays: who used to be able to sign in as whom is a fact. */
export async function revokeIdentity(tx: Tx, id: string): Promise<void> {
  await tx.query('update org.external_identity set revoked_at = now() where id = $1', [id]);
}
