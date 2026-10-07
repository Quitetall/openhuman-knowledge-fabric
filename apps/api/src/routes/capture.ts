/**
 * Capture: recording that something happened costs one gesture (ADR 0024, ADR 0034, SAS §8A).
 *
 *   POST /capture/observation
 *     body    { body, subjects?, tags?, observed_at?, gesture_id? }   — and nothing else
 *     headers identity as on every route; `x-kf-acting-role` is OPTIONAL here
 *
 * KF-SAS-RQ-200: the actor supplies no authority, concurrency or idempotency detail, and the
 * server forms each of them on their behalf:
 *
 *   acting assignment  the caller's only live assignment in the organization, derived as the
 *                      caller is identified; or the one they named in `x-kf-acting-role`. Several
 *                      and none named is `422 acting_assignment_ambiguous`, listing them — the
 *                      server never guesses, because a guess attributes the note to a role the
 *                      person did not act in.
 *   idempotency key    the gesture id plus the body's SHA-256 (`formObservationRequest`). A
 *                      gesture id is generated when none is sent, and returned, so a client can
 *                      retry the same gesture and have it replay rather than capture twice.
 *   target             the observation the act creates. No row version: a capture reads nothing.
 *
 * A body naming an acting role, an idempotency key, a version or anything else is refused as
 * `unknown_field` rather than ignored: a field that looks honoured and is not is how a surface
 * grows its own record shape (RQ-203), and that is the drift this route exists to prevent.
 *
 * KF-SAS-RQ-203: this is the one capture seam. `kf note`, the web capture form and agents all
 * reach it, and it dispatches `record_observation` through the same fabric dispatcher as
 * `POST /actions/:actionType`, carrying the caller's attestation. It has no write of its own.
 *
 * KF-SAS-RQ-202: what is written is a `captured` observation, attributed to the caller and
 * audited from the first moment, and unverified until somebody else verifies it (SAS §48A). The
 * answer says so, in the label every other surface uses.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { IdentityRejected, type LiveAssignment } from '@kf/authorization';
import { bindPrincipal, withTransaction, type Pool } from '@kf/database';
import { recordVerification, type VerificationFacts } from '@kf/domain';
import { formObservationRequest } from '@kf/work-control';
import { refuseUnidentified } from './actions/auth.js';
import type { ActionRoutesOptions, Caller, IdentifyCaller } from './actions/contracts.js';
import { actionRejectionBody } from './actions/errors.js';

export interface CaptureRoutesOptions {
  readonly pool: Pool;
  readonly execute: ActionRoutesOptions['execute'];
  readonly identify: IdentifyCaller;
}

/** The whole of what a capture request may say. */
export const CAPTURE_BODY_FIELDS: ReadonlySet<string> = new Set([
  'body',
  'subjects',
  'tags',
  'observed_at',
  'gesture_id',
]);

/**
 * `observation:<gesture>:<64 hex>` must fit `core.action.idempotency_key` (128 characters):
 * 128 − 12 − 1 − 64 leaves 51, and 48 keeps a margin a UUID (36) fits well inside.
 */
export const MAX_GESTURE_ID = 48;
const GESTURE_ID = /^[A-Za-z0-9._:-]{8,48}$/u;
/** A note, not a document: a document is ingested, one named item at a time (RQ-021). */
export const MAX_OBSERVATION_BODY = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CaptureBody {
  readonly body: string;
  readonly subjects?: readonly string[];
  readonly tags?: readonly string[];
  readonly observedAt?: string;
  readonly gestureId?: string;
}

export class CaptureBodyRefused extends Error {
  readonly code: string;
  readonly field: string | undefined;
  constructor(code: string, message: string, field?: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

/** Read a capture body, refusing anything the route does not accept. Pure, for tests. */
export function parseCaptureBody(raw: unknown): CaptureBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CaptureBodyRefused('invalid_body', 'the request body must be a JSON object');
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !CAPTURE_BODY_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new CaptureBodyRefused(
      'unknown_field',
      `a capture carries only ${[...CAPTURE_BODY_FIELDS].join(', ')}; the server forms the ` +
        `acting role, idempotency key and target itself. Not accepted: ${unknown.join(', ')}`,
      unknown[0],
    );
  }
  const body = record['body'];
  if (typeof body !== 'string' || body.trim() === '') {
    throw new CaptureBodyRefused('invalid_body', 'body must be a non-empty string', 'body');
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_OBSERVATION_BODY) {
    throw new CaptureBodyRefused(
      'invalid_body',
      `body is over ${String(MAX_OBSERVATION_BODY)} bytes; a document is ingested, not noted`,
      'body',
    );
  }
  const subjects = record['subjects'];
  if (
    subjects !== undefined &&
    (!Array.isArray(subjects) || !subjects.every((s) => typeof s === 'string' && UUID.test(s)))
  ) {
    throw new CaptureBodyRefused(
      'invalid_body',
      'subjects must be a list of object ids',
      'subjects',
    );
  }
  const tags = record['tags'];
  if (
    tags !== undefined &&
    (!Array.isArray(tags) ||
      !tags.every((t) => typeof t === 'string' && t.trim() !== '' && t.length <= 64))
  ) {
    throw new CaptureBodyRefused(
      'invalid_body',
      'tags must be a list of non-empty strings of at most 64 characters',
      'tags',
    );
  }
  const observedAt = record['observed_at'];
  if (
    observedAt !== undefined &&
    (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt)))
  ) {
    throw new CaptureBodyRefused(
      'invalid_body',
      'observed_at must be an RFC 3339 instant',
      'observed_at',
    );
  }
  const gestureId = record['gesture_id'];
  if (gestureId !== undefined && (typeof gestureId !== 'string' || !GESTURE_ID.test(gestureId))) {
    throw new CaptureBodyRefused(
      'invalid_body',
      `gesture_id must be 8 to ${String(MAX_GESTURE_ID)} characters of [A-Za-z0-9._:-]`,
      'gesture_id',
    );
  }
  return {
    body,
    ...(subjects === undefined ? {} : { subjects: subjects as string[] }),
    ...(tags === undefined ? {} : { tags: tags as string[] }),
    ...(observedAt === undefined ? {} : { observedAt: observedAt as string }),
    ...(gestureId === undefined ? {} : { gestureId: gestureId as string }),
  };
}

function ambiguous(assignments: readonly LiveAssignment[] | undefined, message: string) {
  return { error: 'acting_assignment_ambiguous', message, assignments: assignments ?? [] };
}

export function registerCaptureRoutes(app: FastifyInstance, options: CaptureRoutesOptions): void {
  app.post('/capture/observation', async (request, reply) => {
    let capture: CaptureBody;
    try {
      capture = parseCaptureBody(request.body ?? {});
    } catch (err: unknown) {
      if (err instanceof CaptureBodyRefused) {
        return reply.code(400).send({
          error: err.code,
          message: err.message,
          ...(err.field === undefined ? {} : { field: err.field }),
        });
      }
      throw err;
    }

    let caller: Caller;
    try {
      caller = await options.identify({
        headers: request.headers as Record<string, unknown>,
        deriveAssignment: true,
      });
    } catch (err: unknown) {
      if (err instanceof IdentityRejected && err.failure === 'assignment_ambiguous') {
        return reply.code(422).send(ambiguous(err.assignments, err.message));
      }
      if (err instanceof IdentityRejected && err.failure === 'no_live_assignment') {
        return reply.code(422).send({ error: 'no_live_assignment', message: err.message });
      }
      return refuseUnidentified(reply, err);
    }

    const gestureId = capture.gestureId ?? randomUUID();
    try {
      // The caller's live assignments, read as the caller: bound on their attestation, and the
      // lookup can name nobody else's (20260925090000). `formObservationRequest` then checks
      // the assignment they act under is one of them — the same rule, stated a second time at
      // the seam every surface shares, so a surface cannot skip it.
      const live = await withTransaction(options.pool, async (tx) => {
        await bindPrincipal(tx, caller);
        return tx.query<{ assignment_id: string }>(
          'select assignment_id from core.principal_live_assignments()',
        );
      });
      const request_ = formObservationRequest({
        organizationId: caller.organizationId,
        actorId: caller.actorId,
        liveAssignmentIds: live.map((row) => row.assignment_id),
        actingRoleId: caller.actingRoleId,
        gestureId,
        body: capture.body,
        ...(capture.subjects === undefined ? {} : { subjects: capture.subjects }),
        ...(capture.tags === undefined ? {} : { tags: capture.tags }),
        ...(capture.observedAt === undefined ? {} : { observedAt: capture.observedAt }),
        maxClassification: caller.maxClassification,
        ...(caller.attestation === undefined ? {} : { attestation: caller.attestation }),
      });
      const result = await options.execute({ ...request_, requestId: String(request.id) });
      const observationId = result.objectIds[0];
      if (observationId === undefined) {
        request.log.error({ actionId: result.actionId }, 'record_observation created no object');
        return reply.code(500).send({ error: 'internal_error', requestId: request.id });
      }
      // Read back as the caller: what they may now see of what they wrote. A replay answers the
      // observation's state now, which may have moved on since the first capture.
      const state = await withTransaction(options.pool, async (tx) => {
        await bindPrincipal(tx, caller);
        return tx.maybeOne<{
          lifecycle_state: string;
          basis: string | null;
          verified_at: Date | null;
          verified_by: string | null;
          policy_id: string | null;
        }>(
          `select o.lifecycle_state, v.basis, v.verified_at, v.verified_by::text as verified_by,
                  v.policy_id::text as policy_id
             from core.object o
             left join core.object_verification v on v.object_id = o.id
            where o.id = $1`,
          [observationId],
        );
      });
      const facts: VerificationFacts | undefined =
        state?.basis === null || state?.basis === undefined
          ? undefined
          : {
              basis: state.basis,
              verifiedAt: state.verified_at!,
              verifiedBy: state.verified_by!,
              policyId: state.policy_id,
            };
      return reply.code(result.replayed ? 200 : 201).send({
        observationId,
        actionId: result.actionId,
        replayed: result.replayed,
        gestureId,
        actingRoleId: request_.actingRoleId,
        lifecycleState: state?.lifecycle_state ?? 'captured',
        verification: recordVerification(facts),
        auditDigest: result.auditDigest,
      });
    } catch (err: unknown) {
      const refusal = actionRejectionBody(err);
      if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
      throw err;
    }
  });
}
