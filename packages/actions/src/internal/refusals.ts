import { PayloadInvalid } from '@kf/record-atoms';
import { ActionRejected } from './contracts.js';

/**
 * Turn a refusal that arrived as something other than an ActionRejected into one, so every
 * surface that dispatches — HTTP, the agent tools, a CLI — receives the same refusal for the
 * same cause. Anything that is not a recognised refusal is returned unchanged: it is a fault,
 * and a fault must stay a fault rather than become a precondition a caller could act on.
 *
 * Two shapes qualify.
 *
 * A {@link PayloadInvalid} from a materializer, precondition or effect: the caller's payload
 * named a field wrongly. Refused as `precondition_failed` naming the field.
 *
 * A named invariant refused by a database trigger: `check_violation` (SQLSTATE 23514) whose
 * message BEGINS with a rule id (`KF-FIN-001: …`). The rule is identified from the raised text,
 * not from which statement happened to fail, and only a check_violation qualifies: a message
 * that merely mentions a rule id is not a refusal by that rule. The financial rules are guarded
 * twice on purpose, and under concurrency the trigger is the one that wins; that is the control
 * working, so it reaches the caller as a refusal rather than a 500 they retry forever.
 */
export function asActionRefusal(error: unknown): unknown {
  if (error instanceof ActionRejected) return error;
  if (error instanceof PayloadInvalid) {
    return new ActionRejected('precondition_failed', error.message, { field: error.field });
  }
  const rule = databaseRuleViolation(error);
  if (rule !== undefined) {
    return new ActionRejected('precondition_failed', rule.message, {
      rule: rule.id,
      enforcedBy: 'database',
    });
  }
  return error;
}

function databaseRuleViolation(error: unknown): { id: string; message: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code !== '23514' || typeof e.message !== 'string') return undefined;
  const match = /^(KF-[A-Z]+-\d+):/.exec(e.message);
  return match === null ? undefined : { id: match[1]!, message: e.message };
}
