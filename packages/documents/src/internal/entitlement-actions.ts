import { ActionRejected, type ActionEffect, type PreconditionCheck } from '@kf/actions';
import { requireString } from '@kf/record-atoms';
import { TECHNICAL_AUTHORITY_ROLE } from './action-types.js';
import { assertDocumentRole } from './document-authority.js';

interface EntitlementActions {
  readonly assertReleaseExclusion: PreconditionCheck;
  readonly releaseExclusion: ActionEffect;
}

/** Typed action seam for reopening one subtractive entitlement exclusion. */
export function createEntitlementActions(): EntitlementActions {
  const assertReleaseExclusion: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentRole(tx, request, objects, TECHNICAL_AUTHORITY_ROLE);
    if (request.targetIds.length !== 1 || objects.length !== 1) {
      throw new ActionRejected(
        'precondition_failed',
        'release_person_entitlement_exclusion targets exactly one object',
      );
    }
    if (!request.reason?.trim()) {
      throw new ActionRejected(
        'reason_required',
        'release_person_entitlement_exclusion requires a nonblank reason',
      );
    }
    const exclusionId = requireString(request.payload, 'exclusion_id');
    const exclusion = await tx.maybeOne<{
      id: string;
      object_id: string;
      organization_id: string;
      released_at: Date | null;
    }>(
      `select id, object_id, organization_id, released_at
         from content.person_entitlement_exclusion
        where id = $1`,
      [exclusionId],
    );
    if (exclusion === undefined) {
      throw new ActionRejected(
        'precondition_failed',
        'release_person_entitlement_exclusion names no visible exclusion',
        { exclusionId },
      );
    }
    if (
      exclusion.object_id !== objects[0]?.id ||
      exclusion.organization_id !== request.organizationId
    ) {
      throw new ActionRejected(
        'precondition_failed',
        'release_person_entitlement_exclusion target does not match exclusion scope',
        { exclusionId, objectId: exclusion.object_id },
      );
    }
    if (exclusion.released_at !== null) {
      throw new ActionRejected(
        'precondition_failed',
        'release_person_entitlement_exclusion is already released',
        { exclusionId },
      );
    }
  };

  const releaseExclusion: ActionEffect = async (tx, request) => {
    const exclusionId = requireString(request.payload, 'exclusion_id');
    await tx.query('select content.release_person_entitlement_exclusion($1)', [exclusionId]);
  };

  return { assertReleaseExclusion, releaseExclusion };
}
