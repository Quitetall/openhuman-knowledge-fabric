import type { ActionRequest } from '@kf/actions';
import type { Pool } from '@kf/database';
import type {
  Attestor,
  AuthenticationEvent,
  Holdings,
  StepUpPolicy,
  TokenVerifier,
} from '@kf/authorization';
import type { EffectiveAtBounds } from './effective-at.js';

/**
 * Who is calling and what they may see.
 *
 * Two paths, and only one of them is real.
 *
 * With an identity provider configured, a bearer token is verified against the issuer's keys,
 * its subject is mapped to a person, and the acting role is checked against a live role
 * assignment. Role claims in the token are never read — the provider says WHO, the database
 * says what they may do.
 *
 * Without one, identity comes from headers, and that path exists only where the deployment has
 * said twice that it is a development one. A header-trusting auth path reaching production is
 * a total authentication bypass, and "we'll remember to change it" is not a control.
 */
export interface Caller {
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly organizationId: string;
  readonly maxClassification: string;
  /**
   * How and when this caller authenticated. Empty on the header path, which is why step-up is
   * not applied there: every policy would fail, and the development path would be unusable.
   */
  readonly authentication: AuthenticationEvent;
  /**
   * kf-attestor's proof that this person presented a verified token (20260924001000). Every
   * transaction the request opens binds with it; without it the application login binds nobody.
   */
  readonly attestation?: string | undefined;
  /**
   * The declared agent client acting for this person (ADR 0035), when the token was obtained by
   * token exchange. For logs and answers only: `core.action.agent_participation` is written by
   * the database from the attestation, and nothing the API passes can set it.
   */
  readonly agent?: string | undefined;
}

export interface ActionRoutesOptions {
  readonly pool: Pool;
  /**
   * Verifies bearer tokens. When present it is the ONLY way to become a caller; headers are
   * ignored entirely rather than used as a fallback, because a fallback is a bypass that
   * activates exactly when the provider is unreachable.
   */
  readonly verifier?: TokenVerifier;
  /**
   * Where a bearer token becomes an attested caller: kf-attestor over its socket in production,
   * or in-process in development. Takes precedence over `verifier`, which is the in-process form
   * over `pool` (a login that may attest — tests and the development profile only).
   */
  readonly attestor?: Attestor;
  readonly execute: (request: ActionRequest) => Promise<{
    actionId: string;
    replayed: boolean;
    objectIds: readonly string[];
    auditDigest: string;
    receipt?: Readonly<Record<string, unknown>>;
  }>;
  /** True only in development. Header-based identity is refused otherwise. */
  readonly trustHeaders: boolean;
  /**
   * Actions that require a recent or strong authentication, keyed by action type.
   *
   * Only meaningful with a verifier: header identity carries no authentication event, so
   * every policy would fail. That is the correct direction — but it would also make the
   * development path unusable, so step-up is not applied when there is no verifier at all.
   */
  readonly stepUp?: Readonly<Record<string, StepUpPolicy>>;
  /** Bounds on a caller-supplied effectiveAt. Defaults to DEFAULT_EFFECTIVE_AT_BOUNDS. */
  readonly effectiveAtBounds?: EffectiveAtBounds;
}

export type IdentifyCaller = (request: {
  headers: Record<string, unknown>;
  /**
   * With no `x-kf-acting-role`, act under the caller's ONLY live assignment in the organization
   * rather than refusing (ADR 0034 §2). Several, or none, is still refused — as
   * `assignment_ambiguous` listing them, or `no_live_assignment`. The capture route alone asks.
   */
  deriveAssignment?: boolean;
}) => Promise<Caller>;

/**
 * Every live assignment the caller's own person holds, across organizations (20260926120000):
 * the bearer token alone decides whose, and nothing in the request can name anybody else. Refuses
 * as identifying does — `unknown_subject`, `revoked_identity`, `invalid_token`, and
 * `no_live_assignment` for a person holding nothing anywhere.
 */
export type ListHoldings = (request: { headers: Record<string, unknown> }) => Promise<Holdings>;

export interface ActionRequestBody {
  readonly targetIds?: string[];
  readonly payload?: Record<string, never>;
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly expectedVersion?: number;
  readonly effectiveAt?: string;
}
