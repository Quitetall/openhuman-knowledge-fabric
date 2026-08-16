import { ActionRejected } from '@kf/actions';

export function refuse(rule: string, message: string, detail: Record<string, unknown> = {}): never {
  throw new ActionRejected('precondition_failed', `${rule}: ${message}`, { rule, ...detail });
}
