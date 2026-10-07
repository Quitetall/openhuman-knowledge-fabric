/**
 * What the in-app agent and the notifier read about an organization and a person
 * (ADR 0040 decisions 8 and 9, KF-SAS-RQ-271, RQ-274; 20261007300000).
 *
 *   GET /model-routing             → { providerCeiling, revision, setAt }
 *        The highest classification that may leave the host for the caller's organization: to a
 *        provider's model, or in a notification. `internal` (ADR 0040's default) when nothing was
 *        set, with `revision: null`. Every member may read it: an answer names its backend, and why
 *        a question stayed on the host is not a secret from the person asking.
 *   GET /notification-preference   → { digest, push, revision }
 *        The caller's own setting in this organization, or the defaults (`daily`, `urgent`).
 *
 * Both are changed by acts (`POST /actions/set_model_routing_policy`, institutional, and
 * `POST /actions/set_notification_preference`), never here.
 */

import type { FastifyInstance } from 'fastify';
import { bindPrincipal, withTransaction, type Pool } from '@kf/database';
import { refuseUnidentified } from './actions/auth.js';
import type { IdentifyCaller } from './actions/contracts.js';

export interface AgentSettingsRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
}

export function registerAgentSettingsRoutes(
  app: FastifyInstance,
  options: AgentSettingsRoutesOptions,
): void {
  app.get('/model-routing', async (request, reply) => {
    let caller;
    try {
      caller = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return refuseUnidentified(reply, error);
    }
    const row = await withTransaction(options.pool, async (tx) => {
      await bindPrincipal(tx, caller);
      return tx.one<{ ceiling: string; revision: string | null; set_at: Date | null }>(
        `select core.provider_ceiling_in_force($1) as ceiling,
                (select p.revision::text from core.model_routing_policy p
                  where p.organization_id = $1 order by p.revision desc limit 1) as revision,
                (select p.set_at from core.model_routing_policy p
                  where p.organization_id = $1 order by p.revision desc limit 1) as set_at`,
        [caller.organizationId],
      );
    });
    return reply.send({
      providerCeiling: row.ceiling,
      revision: row.revision === null ? null : Number(row.revision),
      setAt: row.set_at === null ? null : row.set_at.toISOString(),
    });
  });

  app.get('/notification-preference', async (request, reply) => {
    let caller;
    try {
      caller = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return refuseUnidentified(reply, error);
    }
    const row = await withTransaction(options.pool, async (tx) => {
      await bindPrincipal(tx, caller);
      // Row security returns only the caller's own rows in this organization.
      return tx.maybeOne<{ digest: string; push: string; revision: string }>(
        `select digest, push, revision::text from core.notification_preference
          order by revision desc limit 1`,
      );
    });
    return reply.send({
      digest: row?.digest ?? 'daily',
      push: row?.push ?? 'urgent',
      revision: row === undefined ? null : Number(row.revision),
    });
  });
}
