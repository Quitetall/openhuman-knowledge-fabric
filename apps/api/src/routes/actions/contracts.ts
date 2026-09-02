import type { ActionRequest } from '@kf/actions';
import type { Pool } from '@kf/database';
import type { AuthenticationEvent, StepUpPolicy, TokenVerifier } from '@kf/authorization';

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
}

export interface ActionRoutesOptions {
  readonly pool: Pool;
  /**
   * Verifies bearer tokens. When present it is the ONLY way to become a caller; headers are
   * ignored entirely rather than used as a fallback, because a fallback is a bypass that
   * activates exactly when the provider is unreachable.
   */
  readonly verifier?: TokenVerifier;
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
}

export type IdentifyCaller = (request: { headers: Record<string, unknown> }) => Promise<Caller>;

export interface ActionRequestBody {
  readonly targetIds?: string[];
  readonly payload?: Record<string, never>;
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly expectedVersion?: number;
  readonly effectiveAt?: string;
}
