/**
 * Granting a person a clearance, as a typed action and as a shared write.
 *
 * There are two callers and there must be exactly one implementation of the write. The normal
 * path is the dispatcher: an already-authorized person grants a colleague a clearance, and the
 * action, audit event and outbox message all follow from that. The other path is bootstrap —
 * `apps/api/src/admin/grant-authority.ts` — which exists because dispatch binds authoritative
 * clearance before effects run, so the FIRST clearance in an organization cannot be granted
 * through the dispatcher without the clearance already existing.
 *
 * Two implementations of "insert a clearance" would be two places for the reason, the grantor
 * and the granting action to drift apart, on the table that decides what everybody can see.
 */

import type { ActionEffect } from '@kf/actions';
import type { Tx } from '@kf/database';

export interface PersonClearanceGrant {
  readonly personId: string;
  readonly organizationId: string;
  readonly classification: string;
  /** The person who decided. Not the subject, and not the process. */
  readonly grantedBy: string;
  /** The recorded act. `granted_by_action` is NOT NULL for exactly this reason. */
  readonly grantedByAction: string;
  readonly reason: string;
}

/** The single write. Both the dispatched effect and the bootstrap command go through here. */
export async function insertPersonClearance(tx: Tx, grant: PersonClearanceGrant): Promise<string> {
  if (grant.reason.trim() === '') {
    // org.person_clearance.reason has a non-blank CHECK. Naming it here means the caller reads
    // why rather than decoding a constraint violation.
    throw new Error('a clearance needs a reason: the record has to say why it was granted');
  }
  const row = await tx.one<{ id: string }>(
    `insert into org.person_clearance
       (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
     values ($1,$2,$3,$4,$5,$6)
     returning id`,
    [
      grant.personId,
      grant.organizationId,
      grant.classification,
      grant.grantedBy,
      grant.grantedByAction,
      grant.reason,
    ],
  );
  return row.id;
}

/**
 * `grant_person_clearance` targets the person whose ceiling is being set, and carries the
 * classification in its payload.
 *
 * Deliberately has no materializer: it creates no object. It changes what an existing person is
 * allowed to see, which is why the person must already be named as a target — an action that
 * conjured its own subject would be granting authority to somebody nobody named.
 */
export const grantPersonClearanceEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const person = objects.find((object) => object.object_type === 'person');
  if (person === undefined) {
    throw new Error(
      'grant_person_clearance must target the person being cleared; no person was among its ' +
        'targets, so there is nobody to grant anything to',
    );
  }

  const classification = request.payload?.['max_classification'];
  if (typeof classification !== 'string' || classification.trim() === '') {
    throw new Error(
      'grant_person_clearance needs max_classification in its payload: this is the ceiling on ' +
        'everything the person can see and it is never inferred',
    );
  }

  const reason = request.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(
      'grant_person_clearance needs a reason; a clearance with no stated why is not a record',
    );
  }

  await insertPersonClearance(tx, {
    personId: person.id,
    organizationId: person.organization_id,
    classification: classification.trim(),
    grantedBy: request.actorId,
    grantedByAction: ctx.actionId,
    reason: reason.trim(),
  });
};

/** Action types this package owns, for the composition root. */
export const AUTHORITY_ACTION_IDS = ['grant_person_clearance'] as const;

export const AUTHORITY_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  grant_person_clearance: grantPersonClearanceEffect,
};
