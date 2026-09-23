/**
 * The action endpoint. One route, every controlled change.
 *
 * There is no `PATCH /work-orders/:id`. There never will be, and the shape of this file is
 * the reason: a record that can be changed by field assignment cannot answer "who moved it,
 * under what authority, and why". Every write in the system is
 *
 *   POST /actions/:actionType
 *     body    { targetIds, payload, reason, idempotencyKey, expectedVersion?, effectiveAt? }
 *     headers x-kf-actor, x-kf-acting-role, x-kf-organization  (identity is never in the body,
 *             so a receipt cannot be re-attributed by editing one)
 *
 * and the dispatcher decides whether it is allowed. An endpoint that bypassed it would
 * bypass the audit chain, the state machine and the invariants at once.
 *
 * THIS LIST USED TO NAME FOUR BODY FIELDS AND OMIT `expectedVersion`, which `write-route.ts`
 * has always read. An integrating client read this comment as the route contract, concluded
 * optimistic concurrency was unavailable, and wrote that into its own specification — so the
 * omission travelled into another repository's obligations before anyone noticed. `requestId`
 * and the recorded time are assigned by the server and are deliberately not accepted here.
 *
 * `expectedVersion` is the row version the caller read. Drift is refused as `version_conflict`
 * with HTTP 409; it never overwrites.
 *
 * `effectiveAt` is when the change took effect, as opposed to when it was recorded. Absent, it
 * is the database clock at dispatch. Present, it must be canonical and within bounds: at most
 * five minutes ahead of this host, and no further back than KF_EFFECTIVE_AT_BACKDATE_DAYS
 * (default 30) unless the action type is listed in KF_EFFECTIVE_AT_BACKDATABLE_ACTIONS.
 * Anything else is refused as `effective_at_out_of_bounds` with HTTP 400, before dispatch.
 *
 * Read routes are separate and plural, because reading is not the inverse of writing here:
 * a work order is written by an action and read as a projection over several tables.
 */

import type { FastifyInstance } from 'fastify';
import { DEFAULT_STEP_UP } from '@kf/authorization';
import {
  createCallerIdentifier,
  CallerRejected,
  callerFrom,
  unidentified,
} from './actions/auth.js';
import type { ActionRoutesOptions, Caller, IdentifyCaller } from './actions/contracts.js';
import { DEFAULT_EFFECTIVE_AT_BOUNDS } from './actions/effective-at.js';
import { registerReadRoutes } from './actions/read-routes.js';
import { registerActionPostRoute, registerUnavailableActionRoute } from './actions/write-route.js';

export type { ActionRoutesOptions, Caller, IdentifyCaller };
export { CallerRejected, callerFrom, createCallerIdentifier, unidentified };

export async function registerActionRoutes(
  app: FastifyInstance,
  options: ActionRoutesOptions,
): Promise<void> {
  const { pool, execute } = options;
  const verifier = options.attestor ?? options.verifier;
  const stepUp = options.stepUp ?? DEFAULT_STEP_UP;

  /**
   * The caller, from a token or from headers — never from both.
   *
   * Which one is decided at startup, not per request. A route that accepted a token when it
   * had one and headers otherwise would let anybody who could omit a header downgrade the
   * whole authentication scheme.
   */
  const identify = createCallerIdentifier(pool, verifier, { trustHeaders: options.trustHeaders });

  if (verifier === undefined && !options.trustHeaders) {
    registerUnavailableActionRoute(app);
    return;
  }

  registerActionPostRoute(app, {
    execute,
    identify,
    stepUp,
    verifier,
    effectiveAtBounds: options.effectiveAtBounds ?? DEFAULT_EFFECTIVE_AT_BOUNDS,
  });
  registerReadRoutes(app, { pool, identify });
}
