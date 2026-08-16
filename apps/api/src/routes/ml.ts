/** Authenticated, privacy-minimal HTTP interface over append-only ML registry. */

import type { FastifyInstance } from 'fastify';
import type { ActionRequest, ActionResult } from '@kf/actions';
import type { Pool, Tx } from '@kf/database';
import type { IdentifyCaller } from './actions.js';
import { registerGovernedAliasRoute } from './ml/governed-alias-route.js';
import { registerMetricEventRoute } from './ml/metric-event-route.js';
import { registerRunProjectionRoute } from './ml/run-projection-route.js';

export interface MlRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
  readonly executeInTransaction: (tx: Tx, request: ActionRequest) => Promise<ActionResult>;
}

export async function registerMlRoutes(
  app: FastifyInstance,
  options: MlRoutesOptions,
): Promise<void> {
  registerGovernedAliasRoute(app, options);
  registerRunProjectionRoute(app, options);
  registerMetricEventRoute(app, options);
}
