import { ActionRejected, type ActionFailure } from '@kf/actions';

/** How each refusal maps to a status code. */
const STATUS: Record<ActionFailure, number> = {
  unknown_action: 404,
  actor_not_authorized: 403,
  classification_not_granted: 403,
  role_not_held: 403,
  act_not_granted: 403,
  separation_of_duty: 403,
  object_not_visible: 404,
  version_conflict: 409,
  illegal_transition: 409,
  idempotency_conflict: 409,
  precondition_failed: 422,
  reason_required: 400,
};

/**
 * Recognise a named invariant refused by a database trigger.
 *
 * The triggers raise `check_violation` with a message beginning with the rule id, so the rule
 * is identified from the raised text rather than from which statement happened to fail. Only
 * `check_violation` qualifies: a message that merely mentions a rule id is not a refusal by
 * that rule.
 */
function ruleViolation(err: unknown): { id: string; message: string } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: string; message?: string };
  if (e.code !== '23514' || typeof e.message !== 'string') return undefined;
  const match = /^(KF-[A-Z]+-\d+):/.exec(e.message);
  return match === null ? undefined : { id: match[1]!, message: e.message };
}

export function actionRejectionBody(err: unknown):
  | {
      readonly status: number;
      readonly body: Record<string, unknown>;
    }
  | undefined {
  if (err instanceof ActionRejected) {
    return {
      status: STATUS[err.failure] ?? 422,
      body: { error: err.failure, message: err.message, detail: err.detail },
    };
  }
  // A financial invariant refused by its TRIGGER rather than by its precondition. Both
  // layers guard the same rules on purpose, and under concurrency the database is the
  // one that wins — two acceptances can each pass the application check and only one
  // survive the row lock. That is the control working, so it must reach the caller as a
  // refusal they can act on, not as a 500 they retry forever.
  const rule = ruleViolation(err);
  if (rule === undefined) return undefined;
  return {
    status: 422,
    body: {
      error: 'precondition_failed',
      message: rule.message,
      detail: { rule: rule.id, enforcedBy: 'database' },
    },
  };
}
