import {
  ActionRejected,
  assertMeaningfulReason,
  type ActionEffect,
  type PreconditionCheck,
} from '@kf/actions';
import { requireString } from '@kf/record-atoms';
import { TECHNICAL_AUTHORITY_ROLE } from './action-types.js';
import { assertDocumentRole } from './document-authority.js';

interface VerificationActions {
  readonly assertVerifyRecord: PreconditionCheck;
  readonly verifyRecord: ActionEffect;
}

const BASES = ['reviewed_individually', 'promoted_in_bulk'] as const;

/**
 * Recording that somebody has checked one record (KF-SAS-RQ-228 to RQ-232).
 *
 * **One act, one record, and that is KF-SAS-RQ-227 rather than a convenience.** A gesture may
 * dispatch many of these — clicking verify on five hundred records produces five hundred acts —
 * but it may not dispatch one act covering several, because that is "I admitted this folder" by
 * another route, and the ledger would then carry one entry where five hundred decisions were
 * made. Enforcing it here means no caller can express the forbidden shape.
 *
 * **The basis is a closed vocabulary and is required** (RQ-231). Reviewing five hundred records
 * one at a time and promoting five hundred in one gesture are different facts. A ledger that
 * writes "verified" for both has made the word carry no information, and an auditor asking
 * whether a person looked at this record then has no answer available.
 */
export function createVerificationActions(): VerificationActions {
  const assertVerifyRecord: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentRole(tx, request, objects, TECHNICAL_AUTHORITY_ROLE);

    if (request.targetIds.length !== 1 || objects.length !== 1) {
      throw new ActionRejected(
        'precondition_failed',
        'verify_record targets exactly one record; one gesture may dispatch many acts, but one ' +
          'act may not cover several records (KF-SAS-RQ-227)',
        { targets: request.targetIds.length },
      );
    }
    assertMeaningfulReason(request);

    const basis = requireString(request.payload, 'basis');
    if (!(BASES as readonly string[]).includes(basis)) {
      throw new ActionRejected(
        'precondition_failed',
        `verify_record basis must be one of ${BASES.join(', ')}`,
        { basis },
      );
    }

    // KF-SAS-RQ-231: two individual reviews inside the database's interval are not two reviews
    // a person made. Asked here, before the insert, so the refusal names the bulk gesture as a
    // precondition rather than surfacing as a database error; the same function also takes the
    // verifier's lock, so a concurrent act waits and then sees this one (20260924000300). The
    // trigger asks again for anyone who did not come through here.
    if (basis === 'reviewed_individually') {
      const pace = await tx.one<{ refusal: string | null }>(
        'select core.individual_review_refusal($1) as refusal',
        [request.actorId],
      );
      if (pace.refusal !== null) {
        throw new ActionRejected('precondition_failed', pace.refusal, {
          basis,
          bulkGesture: 'POST /verifications/bulk',
        });
      }
    }

    const target = objects[0]?.id;
    const already = await tx.maybeOne<{ basis: string }>(
      'select basis from core.object_verification where object_id = $1',
      [target],
    );
    if (already !== undefined) {
      // Not an idempotent no-op. Verification names who checked it and how, so a second one is a
      // different claim by a different person — it needs its own act type and its own rules about
      // what supersession means, and inventing those silently here would be the wrong place.
      throw new ActionRejected(
        'precondition_failed',
        'verify_record names a record that is already verified',
        { objectId: target, basis: already.basis },
      );
    }
  };

  const verifyRecord: ActionEffect = async (tx, request) => {
    await tx.query(
      `insert into core.object_verification (object_id, verified_by, basis, recorded_by_action)
         values ($1, $2, $3, core.current_action_id())`,
      [request.targetIds[0], request.actorId, requireString(request.payload, 'basis')],
    );
  };

  return { assertVerifyRecord, verifyRecord };
}
