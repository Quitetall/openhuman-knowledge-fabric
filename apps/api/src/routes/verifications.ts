/**
 * The bulk verification gesture: many records promoted in one decision, recorded as that.
 *
 *   POST /verifications/bulk
 *     body  { recordIds, reason, idempotencyKey, acceptBulk? }
 *
 * KF-SAS-RQ-231: reviewing five hundred records one at a time and promoting five hundred in one
 * gesture are different facts, and `core.object_verification.basis` says which. The caller used
 * to declare it on every `verify_record`, so a script could record five hundred individual
 * reviews. This route is the supported way to promote many, and it STAMPS the basis: every act
 * it dispatches says `promoted_in_bulk`, whatever the caller would have said. The database
 * enforces the other half — `reviewed_individually` twice within a second by one verifier is
 * refused (20260924000300), with a message that points here.
 *
 * KF-SAS-RQ-227: one gesture, many acts. Each record gets its own `verify_record` act, its own
 * ledger row and audit event, through the same dispatcher as `POST /actions/verify_record` —
 * so every check that applies to one verification (technical authority, separation of duty,
 * already verified, visibility) applies to each of these. One act covering several records is
 * the shape RQ-227 forbids, and this route cannot express it.
 *
 * Refusals are per record and do not undo the others: a record somebody else verified a moment
 * ago is refused as already verified, and the rest of the gesture still stands. The answer names
 * every record's outcome, and is 207 when any was refused so a client reading only the status
 * cannot mistake a partial gesture for a whole one. Each act's idempotency key is derived from
 * the gesture's, so a retried gesture replays the acts that landed and completes the rest.
 *
 * The size ceiling is the sync's (apps/api/src/sync/plan.ts): a gesture over DEFAULT_BULK_CEILING
 * needs `acceptBulk: true`, and none may exceed MAX_BULK_CEILING — a thousand-record selection
 * made by mistake looks exactly like one made on purpose.
 */

import type { FastifyInstance } from 'fastify';
import { assertMeaningfulReason, type ActionRequest } from '@kf/actions';
import { unidentified } from './actions/auth.js';
import type { ActionRoutesOptions, Caller, IdentifyCaller } from './actions/contracts.js';
import { actionRejectionBody } from './actions/errors.js';
import { DEFAULT_BULK_CEILING, MAX_BULK_CEILING } from '../sync/plan.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The per-act key is `<gesture key>:<record id>`, and `core.action.idempotency_key` holds at
 * most 128 characters: 128 − 37 leaves 91 for the gesture's own.
 */
const MAX_GESTURE_KEY = 91;

export interface VerificationRoutesOptions {
  readonly execute: ActionRoutesOptions['execute'];
  readonly identify: IdentifyCaller;
}

interface BulkVerificationBody {
  readonly recordIds?: unknown;
  readonly reason?: unknown;
  readonly idempotencyKey?: unknown;
  readonly acceptBulk?: unknown;
}

type Outcome =
  | { readonly recordId: string; readonly actionId: string; readonly replayed: boolean }
  | { readonly recordId: string; readonly error: string; readonly message: string };

function bad(error: string, message: string) {
  return { error, message };
}

export function registerVerificationRoutes(
  app: FastifyInstance,
  options: VerificationRoutesOptions,
): void {
  app.post<{ Body: BulkVerificationBody }>('/verifications/bulk', async (request, reply) => {
    let caller: Caller;
    try {
      caller = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (err: unknown) {
      return reply.code(401).send(unidentified(err));
    }

    const body = request.body ?? {};
    const key = body.idempotencyKey;
    if (typeof key !== 'string' || key.length < 8 || key.length > MAX_GESTURE_KEY) {
      return reply
        .code(400)
        .send(
          bad(
            'idempotency_key_required',
            `idempotencyKey must be supplied by the caller, 8 to ${String(MAX_GESTURE_KEY)} characters`,
          ),
        );
    }
    const ids = body.recordIds;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id): id is string => typeof id === 'string' && UUID.test(id))
    ) {
      return reply
        .code(400)
        .send(bad('invalid_record_ids', 'recordIds must be a non-empty array of lowercase uuids'));
    }
    if (new Set(ids).size !== ids.length) {
      // A record named twice would be refused the second time as already verified; saying so
      // here is clearer than a refusal the caller has to decode.
      return reply
        .code(400)
        .send(bad('invalid_record_ids', 'recordIds names a record more than once'));
    }
    if (ids.length > MAX_BULK_CEILING) {
      return reply
        .code(400)
        .send(
          bad(
            'bulk_ceiling_exceeded',
            `this gesture would verify ${String(ids.length)} records, above the hard limit of ` +
              `${String(MAX_BULK_CEILING)} that no confirmation lifts. Split it.`,
          ),
        );
    }
    if (ids.length > DEFAULT_BULK_CEILING && body.acceptBulk !== true) {
      return reply
        .code(400)
        .send(
          bad(
            'bulk_confirmation_required',
            `this gesture would verify ${String(ids.length)} records, above the ceiling of ` +
              `${String(DEFAULT_BULK_CEILING)}. A selection made by mistake looks exactly like ` +
              'this one. Send acceptBulk: true if it is what you meant.',
          ),
        );
    }

    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const act = (recordId: string): ActionRequest => ({
      actionType: 'verify_record',
      actorId: caller.actorId,
      actingRoleId: caller.actingRoleId,
      organizationId: caller.organizationId,
      maxClassification: caller.maxClassification,
      targetIds: [recordId],
      idempotencyKey: `${key}:${recordId}`,
      requestId: String(request.id),
      ...(reason === undefined ? {} : { reason }),
      // Stamped here, never read from the body: this is the whole point of the route.
      payload: { basis: 'promoted_in_bulk' },
    });

    // One reason for the whole gesture, so it is judged once rather than refused N times.
    try {
      assertMeaningfulReason(act(ids[0]!));
    } catch (err: unknown) {
      const refusal = actionRejectionBody(err);
      if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
      throw err;
    }

    const outcomes: Outcome[] = [];
    for (const recordId of ids) {
      try {
        const result = await options.execute(act(recordId));
        outcomes.push({ recordId, actionId: result.actionId, replayed: result.replayed });
      } catch (err: unknown) {
        const refusal = actionRejectionBody(err);
        if (refusal === undefined) {
          request.log.error({ err, recordId }, 'bulk verification act failed');
          outcomes.push({
            recordId,
            error: 'internal_error',
            message: `internal error; request ${String(request.id)}`,
          });
          continue;
        }
        outcomes.push({
          recordId,
          error: String(refusal.body['error']),
          message: String(refusal.body['message']),
        });
      }
    }

    const applied = outcomes.filter((o) => 'actionId' in o);
    const refused = outcomes.filter((o) => 'error' in o);
    const status =
      refused.length > 0 ? 207 : applied.some((o) => 'replayed' in o && !o.replayed) ? 201 : 200;
    return reply.code(status).send({
      basis: 'promoted_in_bulk',
      requested: ids.length,
      applied,
      refused,
    });
  });
}
