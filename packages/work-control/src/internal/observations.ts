import { createHash } from 'node:crypto';
import {
  ActionRejected,
  type ActionEffect,
  type ActionMaterializer,
  type ActionRequest,
} from '@kf/actions';
import { classificationFrom, createControlledObject, requireString } from '@kf/record-atoms';

/**
 * Observations — ADR 0034 (proposed): captured in one gesture, promoted by a separate act.
 *
 * `record_observation` is NOT institutional: it needs a live assignment in the organization and
 * nothing else — no act grant, no approval. `promote_observation` is (`requires: act`), and
 * `withdraw_observation` retires one nobody should rely on. An observation is unverified until
 * somebody verifies it, exactly as any record (SAS §48A): nothing here writes a verification.
 *
 * Owned by work control, as the record of what was tried and what was seen while doing work. The
 * capture SURFACES (HTTP, `kf note`, the web form, agents) are a later package; they all call
 * `formObservationRequest` and the one dispatcher (RQ-203), so none can grow its own shape.
 */

export const OBSERVATION_ACTION_IDS = [
  'record_observation',
  'promote_observation',
  'withdraw_observation',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidList(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !UUID.test(v))) {
    throw new ActionRejected('precondition_failed', `${key} must be a list of object ids`, { key });
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) {
    throw new ActionRejected('precondition_failed', `${key} names an object twice`, { key });
  }
  return ids;
}

function tagList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ActionRejected('precondition_failed', 'tags must be a list of strings');
  }
  return value as string[];
}

/**
 * The title is formed, not asked for (RQ-200): the first line of the body, cut to the envelope's
 * 240 characters. A person noting something should not have to name it first.
 */
export function observationTitle(body: string): string {
  const first = body.trim().split(/\r?\n/, 1)[0]!.trim();
  return first.length <= 240 ? first : `${first.slice(0, 239)}…`;
}

/** Creates the observation and its typed row. Subjects are written by the effect, below. */
const recordObservation: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) {
    throw new ActionRejected(
      'precondition_failed',
      'record_observation captures a new observation; it names no target',
    );
  }
  const body = requireString(request.payload, 'body');
  const observedAt = request.payload?.['observed_at'];
  if (observedAt !== undefined && (typeof observedAt !== 'string' || !Date.parse(observedAt))) {
    throw new ActionRejected('precondition_failed', 'observed_at must be an RFC 3339 instant');
  }
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'observation',
    authorityDomain: 'project',
    lifecycleState: 'captured',
    title: observationTitle(body),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await tx.query(
    `insert into content.observation (id, body, observed_at, tags)
     values ($1, $2, coalesce($3::timestamptz, now()), $4::text[])`,
    [id, body, observedAt ?? null, tagList(request.payload?.['tags'])],
  );
  return [id];
};

/**
 * What the observation is about, as `concerns` relations from it. Written in the effect, after
 * the action row exists, so each edge names the act that drew it.
 */
const recordSubjects: ActionEffect = async (tx, request, objects, ctx) => {
  const observation = objects.find((o) => o.object_type === 'observation');
  if (observation === undefined) return;
  for (const subject of uuidList(request.payload?.['subjects'], 'subjects')) {
    await tx.query(
      `insert into core.relation (relation_type, source_id, target_id, created_by, authorizing_action)
       values ('concerns', $1, $2, $3, $4)`,
      [observation.id, subject, request.actorId, ctx.actionId],
    );
  }
};

/**
 * Promotion moves captured -> promoted (the transition does that). When the observation became a
 * controlled record of another type, that record is created by its own create act in the same
 * transaction, and names it here as `promoted_to`: the record is `derived_from` the observation,
 * so the promotion cites its basis and the record cites where it came from.
 */
const promoteObservation: ActionEffect = async (tx, request, objects, ctx) => {
  const observation = objects.find((o) => o.object_type === 'observation');
  if (observation === undefined) {
    throw new ActionRejected('precondition_failed', 'promote_observation names no observation');
  }
  for (const record of uuidList(request.payload?.['promoted_to'], 'promoted_to')) {
    await tx.query(
      `insert into core.relation (relation_type, source_id, target_id, created_by, authorizing_action)
       values ('derived_from', $1, $2, $3, $4)`,
      [record, observation.id, request.actorId, ctx.actionId],
    );
  }
};

export const OBSERVATION_MATERIALIZERS: Readonly<Record<string, ActionMaterializer>> = {
  record_observation: recordObservation,
};

export const OBSERVATION_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  record_observation: recordSubjects,
  promote_observation: promoteObservation,
};

export interface ObservationGesture {
  readonly organizationId: string;
  readonly actorId: string;
  /** The caller's live assignments in the organization, as the surface's resolver found them. */
  readonly liveAssignmentIds: readonly string[];
  /** Named only when the caller holds several and chose one. */
  readonly actingRoleId?: string;
  /** Stable per gesture: a retry of the same click carries the same id. */
  readonly gestureId: string;
  readonly body: string;
  readonly subjects?: readonly string[];
  readonly tags?: readonly string[];
  readonly observedAt?: string;
  readonly maxClassification: string;
  readonly attestation?: string;
}

/**
 * The server half of RQ-200: everything the actor does not supply.
 *
 * The acting assignment is the caller's only live one, or the one they named; several and none
 * named is refused rather than guessed, because a guess attributes the observation to a role the
 * person did not act in. The idempotency key is the gesture id plus the body's digest (ADR 0034
 * §2), so a retried gesture replays and a different note under a reused gesture id does not. The
 * target is the observation the act creates. No row version: a capture reads nothing first.
 */
export function formObservationRequest(gesture: ObservationGesture): ActionRequest {
  const live = [...new Set(gesture.liveAssignmentIds)];
  let actingRoleId: string;
  if (gesture.actingRoleId !== undefined) {
    if (!live.includes(gesture.actingRoleId)) {
      throw new ActionRejected(
        'role_not_held',
        'the named assignment is not one of the caller’s live assignments',
      );
    }
    actingRoleId = gesture.actingRoleId;
  } else if (live.length === 1) {
    actingRoleId = live[0]!;
  } else {
    throw new ActionRejected(
      'role_not_held',
      live.length === 0
        ? 'recording an observation needs a live assignment in this organization'
        : 'the caller holds several live assignments; name the one this observation is made in',
      { liveAssignments: live.length },
    );
  }
  const digest = createHash('sha256').update(gesture.body, 'utf8').digest('hex');
  const payload: Record<string, string | string[]> = { body: gesture.body };
  if (gesture.subjects !== undefined) payload['subjects'] = [...gesture.subjects];
  if (gesture.tags !== undefined) payload['tags'] = [...gesture.tags];
  if (gesture.observedAt !== undefined) payload['observed_at'] = gesture.observedAt;
  return {
    actionType: 'record_observation',
    actorId: gesture.actorId,
    actingRoleId,
    targetIds: [],
    payload,
    idempotencyKey: `observation:${gesture.gestureId}:${digest}`,
    organizationId: gesture.organizationId,
    maxClassification: gesture.maxClassification,
    ...(gesture.attestation === undefined ? {} : { attestation: gesture.attestation }),
  };
}
