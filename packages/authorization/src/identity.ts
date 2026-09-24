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
 *   agent       an `act` claim, when present, is exactly `{ client_id }`, one level deep, and
 *               names the client the token was issued to (`azp`) — ADR 0035; see `agentOf`
 *
 * and then the database is asked to ATTEST that the person is present (20260924001000): an
 * attestation the application login must hand back to `core.bind_principal` before it may bind
 * that person at all. This code therefore runs in the kf-attestor process, under a login that
 * holds `kf_attestor` — not in the API, whose login may not attest. The API reaches it through
 * an `Attestor` (attestor-client.ts); only the development profile runs it in-process.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Pool, Tx } from '@kf/database';
import { issueAttestation, withTransaction } from '@kf/database';
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
  /**
   * The database's attestation that this person presented this token (20260924001000), for
   * this organization and assignment at or below this ceiling. Every transaction the request
   * opens binds with it. Absent only from `resolveIn`, which proves nothing about presence.
   */
  readonly attestation?: string | undefined;
  /**
   * The declared agent client this person is acting through (ADR 0035): the `act.client_id` of
   * a token obtained by token exchange, or undefined for the person's own token. Informational
   * for the API — the DATABASE records participation from the attestation, and nothing the API
   * does with this field reaches the ledger.
   */
  readonly agent?: string | undefined;
}

export type IdentityFailure =
  | 'no_token'
  | 'invalid_token'
  | 'unknown_subject'
  | 'revoked_identity'
  | 'role_not_held'
  | 'classification_not_granted'
  | 'no_role_requested'
  | 'undeclared_agent';

export class IdentityRejected extends Error {
  readonly failure: IdentityFailure;

  constructor(failure: IdentityFailure, message: string) {
    super(message);
    this.name = 'IdentityRejected';
    this.failure = failure;
  }
}

/**
 * The JWS algorithms a token may be signed with: what the realm signs with
 * (deploy/keycloak/knowledge-fabric-realm.json, `defaultSignatureAlgorithm`).
 *
 * Pinned, not left to the key set. Without a list, jose accepts whatever `alg` the token header
 * names so long as a key in the set fits it, so the accepted algorithm is chosen by the token's
 * author. Changing the realm's algorithm is then a deliberate change here as well.
 */
export const OIDC_SIGNING_ALGORITHMS: readonly string[] = ['RS256'];

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
        algorithms: [...OIDC_SIGNING_ALGORITHMS],
        clockTolerance: this.#config.clockToleranceSeconds ?? 30,
      });
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        throw new Error('token has no finite expiration');
      }
      // A malformed delegation is a token defect like any other, refused here so the operator's
      // log carries the reason and the caller sees the one collapsed code.
      agentOf(payload);
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

/** What an agent client id may look like: Keycloak client ids, conservatively. */
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

/**
 * The agent a verified token names, or undefined for a person's own token (ADR 0035).
 *
 * RFC 8693 §4.1 puts the acting party in an `act` claim. Keycloak 26.4's standard token exchange
 * emits none of its own: it records the exchanging client only as `azp` (measured against the
 * pinned image, docs/deployment/identity-and-login.md). The realm therefore stamps
 * `act.client_id` on each agent client with a hardcoded-claim mapper, and a token issued to that
 * client carries `{"act": {"client_id": "<the client>"}}`. That is the one shape accepted:
 *
 *   - `act` absent                      -> a direct act, no agent
 *   - `act` an object whose ONLY member is `client_id`, a client id equal to `azp` -> that agent
 *   - anything else                     -> throws; the verifier refuses the token
 *
 * `act.sub` is not accepted in place of `client_id`: in Keycloak an actor subject is a user id
 * (a service account's uuid), not the client, and nothing here maps one to the other. A nested
 * `act` (a chain of actors) is refused rather than flattened: depth 1 is the whole model, and a
 * chain would record only its outermost link. `client_id` must equal `azp` because the claim is
 * meaningful only as the issuer's statement about the client the token was issued TO; a mapper
 * stamping some other client's id is a forgery by configuration.
 *
 * Whether that client may take part at all is not decided here: `core.issue_attestation` refuses
 * a client that is not a declared agent, and a token without `act` issued to one that is.
 */
export function agentOf(payload: JWTPayload): string | undefined {
  if (!Object.hasOwn(payload, 'act')) return undefined;
  const act = payload['act'];
  if (typeof act !== 'object' || act === null || Array.isArray(act)) {
    throw new Error('the act claim is not an object');
  }
  const members = Object.keys(act);
  if (members.includes('act')) {
    throw new Error('the act claim is nested; only one level of delegation is accepted');
  }
  if (members.length !== 1 || members[0] !== 'client_id') {
    throw new Error(`the act claim must be exactly {client_id}, got {${members.sort().join(',')}}`);
  }
  const clientId = (act as Record<string, unknown>)['client_id'];
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    throw new Error('act.client_id is not a client id');
  }
  if (payload['azp'] !== clientId) {
    throw new Error('act.client_id is not the client the token was issued to (azp)');
  }
  return clientId;
}

export interface CallerRequest {
  /** The raw bearer token. */
  readonly token: string;
  /** Which of the actor's roles they are acting under, for this request. */
  readonly actingRoleId: string;
  readonly organizationId: string;
  /** Requested ceiling; database clearance may narrow it, never widen it. */
  readonly maxClassification: string;
}

/**
 * Resolve a verified token into an ATTESTED caller.
 *
 * Every step after verification reads the DATABASE. The token contributes a subject, an
 * authentication event and an expiry, and nothing else.
 *
 * `pool` must be a login that may attest — kf-attestor's own (`kf_attestor`), or an
 * administrator in tests. The application login cannot, by design: that is the whole point of
 * running this in another process.
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
  // `verify` refuses a token without a finite `exp`, so this is always a real instant.
  const expiresAt = new Date((payload.exp as number) * 1000);
  if (expiresAt.getTime() <= Date.now()) {
    // Inside the verifier's clock tolerance, but past its own expiry by our clock. The
    // database will not attest to it, and it is refused as the token failure it is.
    throw new IdentityRejected('invalid_token', 'token rejected');
  }

  const authentication = authenticationEvent(payload);
  // `verify` already refused a malformed `act`, so this only reads it.
  const agent = agentOf(payload);
  const authorizedParty = typeof payload['azp'] === 'string' ? payload['azp'] : undefined;

  return withTransaction(pool, async (tx) => {
    const caller = await resolveIn(tx, { issuer, subject, authentication, ...request });
    // The database re-checks the assignment and clamps the ceiling again as it attests; the
    // attestation expires with the token, or within a minute, whichever is first. It also
    // decides whether the agent may take part, and records it on the attestation, from which
    // every bind of this request seals it for the ledger.
    const attestation = await issueAttestation(tx, caller, expiresAt, {
      agentClientId: agent,
      authorizedParty,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/declared agent/.test(message)) {
        throw new IdentityRejected(
          'undeclared_agent',
          'the token names an agent client that is not declared to act for people here',
        );
      }
      if (/names agent .* but was issued to client/.test(message)) {
        throw new IdentityRejected('invalid_token', 'token rejected');
      }
      throw error;
    });
    return agent === undefined ? { ...caller, attestation } : { ...caller, attestation, agent };
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
  // The resolvers bind their own provisional context for their lookups (20260923000100).
  //
  // `core.object` forces row-level security, which binds a SECURITY DEFINER function too, so
  // the assignment envelope is invisible without an organization bound. This function used to
  // bind one itself — this organization at `restricted`, before it knew who the caller was —
  // which required the application role to be able to bind any organization at any ceiling.
  // That ability is what let a compromised API read every tenant, and it is gone: the
  // database binds, looks, and restores inside the resolver, and the provisional context never
  // reaches this transaction.
  const identity = await tx.maybeOne<{
    person_id: string;
    identity_revoked: boolean;
    role_held: boolean;
  }>(
    `select person_id, identity_revoked, role_held
       from org.resolve_identity_role($1, $2, $3, $4)`,
    [request.issuer, request.subject, request.organizationId, request.actingRoleId],
  );

  if (identity === undefined) {
    // A valid token for somebody this system has never heard of. Refused rather than
    // auto-provisioned: creating a person on first sign-in would let anyone the provider
    // accepts become an actor here, and the actor list is who can be held responsible.
    throw new IdentityRejected(
      'unknown_subject',
      'this identity is not linked to a person in this system',
    );
  }
  if (identity.identity_revoked) {
    throw new IdentityRejected('revoked_identity', 'this identity link has been revoked');
  }
  if (!identity.role_held) {
    throw new IdentityRejected(
      'role_not_held',
      'the acting role is not held by this person, or is not currently valid',
    );
  }

  const classification = await tx
    .maybeOne<{
      effective_classification: string;
      requested_classification: string;
    }>(
      `select effective_classification, requested_classification
       from org.resolve_effective_classification($1, $2, $3, $4)`,
      [identity.person_id, request.organizationId, request.actingRoleId, request.maxClassification],
    )
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code ?? '')
          : '';
      if (code === '42501' || code === 'P0001' || /classification|clearance/i.test(message)) {
        throw new IdentityRejected('classification_not_granted', 'classification ceiling refused');
      }
      throw error;
    });
  if (classification === undefined) {
    throw new IdentityRejected('classification_not_granted', 'classification ceiling refused');
  }

  return {
    actorId: identity.person_id,
    actingRoleId: request.actingRoleId,
    organizationId: request.organizationId,
    maxClassification: classification.requested_classification,
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
