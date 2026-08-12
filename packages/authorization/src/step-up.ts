/**
 * Step-up authentication: how recently, and how strongly, did this person prove who they are.
 *
 * This is the one thing the identity provider IS authoritative about. Role claims are refused
 * because authority belongs to this database — but `auth_time` and `acr` describe the
 * authentication event itself, which happened at the provider and nowhere else. Reading them
 * is not the same mistake in the other direction; it is the only place that answer exists.
 *
 * What it buys: a token minted eight hours ago is a valid token and a poor reason to approve a
 * payment. Sensitive actions can require a recent authentication, and the provider will
 * re-prompt — that is what `max_age` in an authorization request is for.
 *
 * MFA and session lifetime are provider POLICY and are not configured here. What is configured
 * here is which actions refuse to proceed without them.
 */

import type { JWTPayload } from 'jose';

export interface AuthenticationEvent {
  /** When the person actually authenticated, not when the token was minted. */
  readonly authenticatedAt: Date | undefined;
  /** Authentication context class, as the provider reports it. */
  readonly assuranceLevel: string | undefined;
  /** Methods used — `mfa`, `otp`, `hwk`, `pwd`. */
  readonly methods: readonly string[];
}

/**
 * Read the authentication event from a verified token.
 *
 * `auth_time` is optional in OIDC and absent unless the client asked for it, so its absence is
 * reported as `undefined` rather than defaulted to `iat`. Treating mint time as authentication
 * time would silently satisfy every freshness requirement using a refresh token.
 */
export function authenticationEvent(payload: JWTPayload): AuthenticationEvent {
  const authTime = payload['auth_time'];
  const acr = payload['acr'];
  const amr = payload['amr'];
  return {
    authenticatedAt:
      typeof authTime === 'number' && Number.isFinite(authTime)
        ? new Date(authTime * 1000)
        : undefined,
    assuranceLevel: typeof acr === 'string' ? acr : undefined,
    methods: Array.isArray(amr) ? amr.filter((m): m is string => typeof m === 'string') : [],
  };
}

export interface StepUpPolicy {
  /** Authentication must be no older than this. */
  readonly maxAgeSeconds?: number;
  /** One of these assurance levels must be reported. */
  readonly assuranceLevels?: readonly string[];
  /** One of these methods must appear in `amr`. */
  readonly methods?: readonly string[];
}

export type StepUpFailure =
  | 'authentication_age_unknown'
  | 'authentication_too_old'
  | 'assurance_unknown'
  | 'assurance_insufficient'
  | 'method_insufficient';

export interface StepUpResult {
  readonly satisfied: boolean;
  readonly failure?: StepUpFailure;
  readonly detail?: string;
}

/**
 * Does this authentication satisfy the policy?
 *
 * Fails closed on every unknown. A provider that does not report `auth_time` cannot prove the
 * session is recent, and "cannot prove" has to mean "no" — otherwise the control evaporates
 * for exactly the providers least able to enforce it.
 */
export function satisfiesStepUp(
  event: AuthenticationEvent,
  policy: StepUpPolicy,
  now: Date = new Date(),
): StepUpResult {
  if (policy.maxAgeSeconds !== undefined) {
    if (event.authenticatedAt === undefined) {
      return {
        satisfied: false,
        failure: 'authentication_age_unknown',
        detail:
          'the token carries no auth_time, so the age of this authentication cannot be ' +
          'established. Request it with the max_age parameter.',
      };
    }
    const ageSeconds = (now.getTime() - event.authenticatedAt.getTime()) / 1000;
    if (ageSeconds > policy.maxAgeSeconds) {
      return {
        satisfied: false,
        failure: 'authentication_too_old',
        detail: `authenticated ${Math.floor(ageSeconds)}s ago; this action requires ${policy.maxAgeSeconds}s or less`,
      };
    }
  }

  if (policy.assuranceLevels !== undefined && policy.assuranceLevels.length > 0) {
    if (event.assuranceLevel === undefined) {
      return {
        satisfied: false,
        failure: 'assurance_unknown',
        detail: 'the token reports no acr, so the assurance level cannot be established',
      };
    }
    if (!policy.assuranceLevels.includes(event.assuranceLevel)) {
      return {
        satisfied: false,
        failure: 'assurance_insufficient',
        detail: `assurance '${event.assuranceLevel}' is not one of ${policy.assuranceLevels.join(', ')}`,
      };
    }
  }

  if (policy.methods !== undefined && policy.methods.length > 0) {
    if (!policy.methods.some((m) => event.methods.includes(m))) {
      return {
        satisfied: false,
        failure: 'method_insufficient',
        detail:
          event.methods.length === 0
            ? 'the token reports no amr, so the authentication method cannot be established'
            : `authenticated with ${event.methods.join(', ')}; this action requires one of ${policy.methods.join(', ')}`,
      };
    }
  }

  return { satisfied: true };
}

/**
 * Which actions need a recent, strong authentication.
 *
 * Chosen by consequence, not by feeling. Each one either MOVES MONEY, RELEASES A PRODUCT, or
 * WITHDRAWS A CONTROL — the three things somebody borrowing an unlocked laptop could do the
 * most damage with, and the three that are hardest to reverse.
 *
 * Fifteen minutes is short enough that a walk-away session does not carry the authority, and
 * long enough not to re-prompt in the middle of a task.
 */
export const DEFAULT_STEP_UP: Readonly<Record<string, StepUpPolicy>> = {
  // Money.
  authorize_payment: { maxAgeSeconds: 900, methods: ['mfa', 'otp', 'hwk'] },
  record_payment_settlement: { maxAgeSeconds: 900, methods: ['mfa', 'otp', 'hwk'] },
  approve_invoice: { maxAgeSeconds: 900 },
  amend_work_order: { maxAgeSeconds: 900 },
  issue_acceptance: { maxAgeSeconds: 900 },
  // Release.
  make_document_effective: { maxAgeSeconds: 900 },
  promote_configuration_item: { maxAgeSeconds: 900 },
  publish_interface_contract: { maxAgeSeconds: 900 },
  // Withdrawal of a control, and the correction path that can move almost anything.
  invalidate_test_execution: { maxAgeSeconds: 900 },
  close_capa: { maxAgeSeconds: 900 },
  disqualify_supplier: { maxAgeSeconds: 900 },
  correct_record: { maxAgeSeconds: 900 },
};
