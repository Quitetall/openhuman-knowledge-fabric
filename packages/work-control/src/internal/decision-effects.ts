import { ActionRejected, type ActionEffect } from '@kf/actions';
import { requireString } from '../objects.js';

const ADR_BODY_KEYS = ['document_revision_id', 'body_state', 'body_digest'] as const;

function hasAdrBodyPayload(payload: Readonly<Record<string, unknown>> | undefined): boolean {
  return ADR_BODY_KEYS.some((key) => payload?.[key] !== undefined);
}

function expectedBodyState(actionType: string): 'draft' | 'accepted' | null {
  if (actionType === 'propose_decision') return 'draft';
  if (actionType === 'accept_decision') return 'accepted';
  return null;
}

export const recordAdrDecisionBody: ActionEffect = async (tx, request, objects, ctx) => {
  if (!hasAdrBodyPayload(request.payload)) return;
  const bodyState = expectedBodyState(request.actionType);
  if (bodyState === null) return;
  if (requireString(request.payload, 'body_state') !== bodyState) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} cannot record this ADR body state`,
      {
        actionType: request.actionType,
        expectedBodyState: bodyState,
      },
    );
  }
  const decision = objects.find((object) => object.object_type === 'decision_record');
  if (decision === undefined) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} found no decision target`,
      {
        actionType: request.actionType,
      },
    );
  }
  await tx.query(
    `insert into content.adr_decision_body
       (decision_id, document_revision_id, body_state, body_digest, recorded_by_action)
     values ($1, $2, $3, $4, $5)`,
    [
      decision.id,
      requireString(request.payload, 'document_revision_id'),
      bodyState,
      requireString(request.payload, 'body_digest'),
      ctx.actionId,
    ],
  );
};
