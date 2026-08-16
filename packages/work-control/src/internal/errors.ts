import { ActionRejected } from '@kf/actions';

/** A precondition failure, phrased so the caller learns which rule refused them. */
export function refuse(rule: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new ActionRejected('precondition_failed', `${rule}: ${message}`, { rule, ...detail });
}
