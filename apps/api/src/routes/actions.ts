/**
 * The action endpoint. One route, every controlled change.
 *
 * There is no `PATCH /work-orders/:id`. There never will be, and the shape of this file is
 * the reason: a record that can be changed by field assignment cannot answer "who moved it,
 * under what authority, and why". Every write in the system is
 *
 *   POST /actions/:actionType   { targetIds, payload, reason, idempotencyKey }
 *
 * and the dispatcher decides whether it is allowed. An endpoint that bypassed it would
 * bypass the audit chain, the state machine and the invariants at once.
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
import { registerReadRoutes } from './actions/read-routes.js';
import { registerActionPostRoute, registerUnavailableActionRoute } from './actions/write-route.js';

export type { ActionRoutesOptions, Caller, IdentifyCaller };
export { CallerRejected, callerFrom, createCallerIdentifier, unidentified };

export async function registerActionRoutes(
  app: FastifyInstance,
  options: ActionRoutesOptions,
): Promise<void> {
  const { pool, execute, verifier } = options;
  const stepUp = options.stepUp ?? DEFAULT_STEP_UP;

  /**
   * The caller, from a token or from headers — never from both.
   *
   * Which one is decided at startup, not per request. A route that accepted a token when it
   * had one and headers otherwise would let anybody who could omit a header downgrade the
   * whole authentication scheme.
   */
  const identify = createCallerIdentifier(pool, verifier);

  if (verifier === undefined && !options.trustHeaders) {
    registerUnavailableActionRoute(app);
    return;
  }

  registerActionPostRoute(app, { execute, identify, stepUp, verifier });
  registerReadRoutes(app, { pool, identify });
}
