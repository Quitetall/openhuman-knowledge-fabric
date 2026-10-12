/**
 * What the in-app agent and the notifier read about an organization and a person
 * (ADR 0040 decisions 8 and 9, KF-SAS-RQ-271, RQ-274; 20261007300000).
 *
 *   GET /model-routing             → { providerCeiling, revision, setAt }
 *        The highest classification that may leave the host for the caller's organization: to a
 *        provider's model, or in a notification. `internal` (ADR 0040's default) when nothing was
 *        set, with `revision: null`. Every member may read it: an answer names its backend, and why
 *        a question stayed on the host is not a secret from the person asking.
 *   GET /notification-preference   → { digest, push, revision, pushDestination }
 *        The caller's own setting in this organization, or the defaults (`daily`, `urgent`), and
 *        whether they have set a push destination (`true`/`false`) — never the destination.
 *   PUT /notification-destination  { destination: "https://ntfy.sh/<topic>" | null }
 *        → { destinationSet, actionId, receipt }
 *        The gesture that sets where the caller's own urgent push goes (20261011500000). The
 *        destination is validated (a push server the deployment names, one long topic), SEALED to
 *        kf-notify's key and bound to the caller, and only then dispatched as
 *        `set_push_destination`, so the ledger never holds the URL. 503 when the deployment has
 *        no destination key; the database refuses it under an agent's attestation
 *        (KF-NOTIFY-001).
 *
 * The first two are changed by acts (`POST /actions/set_model_routing_policy`, institutional, and
 * `POST /actions/set_notification_preference`), never here.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  DestinationRefused,
  parseDestination,
  parseDestinationPublicKey,
  sealDestination,
} from '@kf/authorization';
import { bindPrincipal, withTransaction, type Pool } from '@kf/database';
import { refuseUnidentified } from './actions/auth.js';
import type { ActionRoutesOptions, Caller, IdentifyCaller } from './actions/contracts.js';
import { actionRejectionBody } from './actions/errors.js';

export interface AgentSettingsRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
  readonly execute?: ActionRoutesOptions['execute'];
  /** The notifier's public key and the push servers a destination may name; absent: 503. */
  readonly pushDestination?: { readonly publicKey: string; readonly servers: readonly string[] };
}

/**
 * Seal `destination` for the caller and dispatch `set_push_destination`; `null` clears it. Throws
 * DestinationRefused for a destination this deployment does not send to, and the dispatcher's
 * refusal for an act the database refuses. The URL never leaves this function unsealed.
 */
export async function setPushDestination(
  execute: ActionRoutesOptions['execute'],
  caller: Caller,
  destination: string | null,
  config: { readonly publicKey: string; readonly servers: readonly string[] },
  requestId?: string,
): ReturnType<ActionRoutesOptions['execute']> {
  const sealed =
    destination === null
      ? null
      : sealDestination(
          parseDestination(destination, config.servers),
          parseDestinationPublicKey(config.publicKey),
          { organizationId: caller.organizationId, personId: caller.actorId },
        );
  return execute({
    actionType: 'set_push_destination',
    actorId: caller.actorId,
    actingRoleId: caller.actingRoleId,
    organizationId: caller.organizationId,
    maxClassification: caller.maxClassification,
    attestation: caller.attestation,
    targetIds: [caller.organizationId],
    // A fresh key: the sealed value differs on every seal, so a retried gesture is a new act that
    // sets the same destination again, never an idempotency conflict.
    idempotencyKey: `push-destination-${randomUUID()}`,
    ...(requestId === undefined ? {} : { requestId }),
    payload: { destination: sealed },
  });
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
      return tx.one<{
        digest: string | null;
        push: string | null;
        revision: string | null;
        destination: boolean | null;
      }>(
        `select (select digest from core.notification_preference
                  order by revision desc limit 1) as digest,
                (select push from core.notification_preference
                  order by revision desc limit 1) as push,
                (select revision::text from core.notification_preference
                  order by revision desc limit 1) as revision,
                (select sealed is not null from core.push_destination
                  order by revision desc limit 1) as destination`,
      );
    });
    return reply.send({
      digest: row.digest ?? 'daily',
      push: row.push ?? 'urgent',
      revision: row.revision === null ? null : Number(row.revision),
      pushDestination: row.destination === true,
    });
  });

  app.put<{ Body: { destination?: unknown } }>(
    '/notification-destination',
    async (request, reply) => {
      let caller: Caller;
      try {
        caller = await options.identify({ headers: request.headers as Record<string, unknown> });
      } catch (error: unknown) {
        return refuseUnidentified(reply, error);
      }
      if (options.pushDestination === undefined || options.execute === undefined) {
        return reply.code(503).send({
          error: 'push_destination_unavailable',
          message:
            'this deployment has no notifier key (KF_NOTIFY_DESTINATION_PUBLIC_KEY); urgent items ' +
            'reach you in the daily digest',
        });
      }
      const destination = request.body?.destination;
      if (destination !== null && typeof destination !== 'string') {
        return reply.code(400).send({
          error: 'invalid_destination',
          message: 'destination must be an https:// push topic URL, or null to clear it',
        });
      }
      try {
        const result = await setPushDestination(
          options.execute,
          caller,
          destination,
          options.pushDestination,
          String(request.id),
        );
        return reply.send({
          destinationSet: destination !== null,
          actionId: result.actionId,
          ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
        });
      } catch (error: unknown) {
        if (error instanceof DestinationRefused) {
          // The message names the rule, never the URL.
          return reply.code(400).send({ error: 'invalid_destination', message: error.message });
        }
        const refusal = actionRejectionBody(error);
        if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
        throw error;
      }
    },
  );
}
