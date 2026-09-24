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
}

export type IdentityFailure =
  | 'no_token'
  | 'invalid_token'
  | 'unknown_subject'
  | 'revoked_identity'
  | 'role_not_held'
  | 'classification_not_granted'
  | 'no_role_requested'
  /** Asked to derive the assignment (ADR 0034 §2), and the person holds several live. */
  | 'assignment_ambiguous'
  /** Asked to derive the assignment, and the person holds none live in the organization. */
  | 'no_live_assignment';

/** One of the caller's own live assignments, as a refusal to guess between them lists it. */
export interface LiveAssignment {
  readonly assignmentId: string;
  readonly roleId: string;
  readonly scopeId: string;
}

export class IdentityRejected extends Error {
  readonly failure: IdentityFailure;
  /**
   * The caller's own live assignments, on `assignment_ambiguous` only: the refusal says what
   * they may choose between, since they are the one who must choose. Never another person's.
   */
  readonly assignments: readonly LiveAssignment[] | undefined;

  constructor(failure: IdentityFailure, message: string, assignments?: readonly LiveAssignment[]) {
    super(message);
    this.name = 'IdentityRejected';
    this.failure = failure;
    this.assignments = assignments;
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
  /** Requested ceiling; database clearance may narrow it, never widen it. */
  readonly maxClassification: string;
  /**
   * When `actingRoleId` is empty: use the person's ONLY live assignment in the organization,
   * and refuse — listing them — when there are several or none (ADR 0034 §2, KF-SAS-RQ-200).
   *
   * Only the capture route asks for this. Everywhere else an empty role is still refused as
   * `no_role_requested`: for an institutional act, which assignment a person acts under is a
   * choice they make. For recording that something happened, a person with one assignment has
   * nothing to choose, and asking them is the friction ADR 0024 exists to remove. A person with
   * several is still asked — the server never guesses between them.
   */
  readonly deriveAssignment?: boolean;
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
  if (request.actingRoleId.trim() === '' && request.deriveAssignment !== true) {
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

  return withTransaction(pool, async (tx) => {
    const caller = await resolveIn(tx, { issuer, subject, authentication, ...request });
    // The database re-checks the assignment and clamps the ceiling again as it attests; the
    // attestation expires with the token, or within a minute, whichever is first.
    const attestation = await issueAttestation(tx, caller, expiresAt);
    return { ...caller, attestation };
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
    readonly deriveAssignment?: boolean;
  },
): Promise<Caller> {
  if (request.actingRoleId.trim() === '') {
    if (request.deriveAssignment !== true) {
      throw new IdentityRejected(
        'no_role_requested',
        'the acting role must be stated; holding a role is not the same as acting under it',
      );
    }
    const derived = await deriveSoleAssignment(tx, request);
    return resolveIn(tx, { ...request, actingRoleId: derived, deriveAssignment: false });
  }
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
 * The person's only live assignment in the organization, or a refusal naming what they hold.
 *
 * Read through `org.resolve_identity_assignments`, which only a login that may attest can call
 * (20260925090000): the lookup happens before anybody is bound, because a binding is to an
 * assignment and none has been chosen yet. The chosen one is then resolved exactly as a stated
 * one would be — held, live, cleared — so deriving it skips no check.
 */
async function deriveSoleAssignment(
  tx: Tx,
  request: { readonly issuer: string; readonly subject: string; readonly organizationId: string },
): Promise<string> {
  const rows = await tx.query<{
    person_id: string;
    identity_revoked: boolean;
    assignment_id: string | null;
    role_id: string | null;
    scope_id: string | null;
  }>(
    `select person_id, identity_revoked, assignment_id, role_id, scope_id
       from org.resolve_identity_assignments($1, $2, $3)`,
    [request.issuer, request.subject, request.organizationId],
  );
  if (rows.length === 0) {
    throw new IdentityRejected(
      'unknown_subject',
      'this identity is not linked to a person in this system',
    );
  }
  if (rows[0]!.identity_revoked) {
    throw new IdentityRejected('revoked_identity', 'this identity link has been revoked');
  }
  const assignments: LiveAssignment[] = rows
    .filter((row) => row.assignment_id !== null)
    .map((row) => ({
      assignmentId: row.assignment_id!,
      roleId: row.role_id!,
      scopeId: row.scope_id!,
    }));
  return soleAssignment(assignments);
}

/** One live assignment is the answer; several or none is a refusal the caller can act on. */
export function soleAssignment(assignments: readonly LiveAssignment[]): string {
  if (assignments.length === 1) return assignments[0]!.assignmentId;
  if (assignments.length === 0) {
    throw new IdentityRejected(
      'no_live_assignment',
      'you hold no live role assignment in this organization, so nothing can be recorded as you',
    );
  }
  throw new IdentityRejected(
    'assignment_ambiguous',
    `you hold ${String(assignments.length)} live role assignments in this organization; name ` +
      'the one you are acting in (x-kf-acting-role) — the server does not choose for you',
    assignments,
  );
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
