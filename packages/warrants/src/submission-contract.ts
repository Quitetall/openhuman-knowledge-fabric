import { ActionRejected } from '@kf/actions';
import type { Document as Submission } from './generated/openwarrant/stage-submission.js';

export type RequestedNextAction = NonNullable<Submission['requested_next_action']>;

// Record makes both new producer enum members and local extra members build errors.
const NEXT_ACTIONS: Readonly<Record<RequestedNextAction, true>> = {
  continue: true,
  verify: true,
  block: true,
  amend: true,
  cancel: true,
};

/** KF requires this field even though the portable submission may omit it. */
export function parseRequestedNextAction(value: unknown): RequestedNextAction {
  if (typeof value !== 'string' || !Object.hasOwn(NEXT_ACTIONS, value.trim())) {
    throw new ActionRejected(
      'precondition_failed',
      'requested_next_action must be continue | verify | block | amend | cancel',
    );
  }
  return value.trim() as RequestedNextAction;
}
