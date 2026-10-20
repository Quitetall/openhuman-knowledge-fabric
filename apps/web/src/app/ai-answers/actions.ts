'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { ApiError } from '../../lib/api';
import { setModelRouting } from '../../lib/api/model-routing';
import { routingRequest } from '../../lib/agent/answers-setting';
import { webCaller } from '../../lib/session';

/**
 * The AI answers page's one button: the organization's model routing, as the signed-in person's own
 * `set_model_routing_policy` act. The form names a ceiling; only `none` and `internal` are accepted
 * (`routingRequest`), and the API and the database decide whether this person may (act authority
 * over the organization) and refuse anything above `internal` again (KF-ROUTE-001).
 */
export async function alignRouting(form: FormData): Promise<void> {
  const caller = await webCaller('/ai-answers');
  const request = routingRequest(form.get('ceiling'));
  if (request === undefined) redirect('/ai-answers?refused=That+setting+is+not+offered+here.');
  const gesture = form.get('gestureId');
  try {
    await setModelRouting(caller, {
      ceiling: request.ceiling,
      reason: request.reason,
      idempotencyKey:
        typeof gesture === 'string' && gesture.length >= 8 ? gesture : `routing-${randomUUID()}`,
    });
  } catch (error: unknown) {
    if (error instanceof ApiError && error.isRefusal) {
      redirect(`/ai-answers?${new URLSearchParams({ refused: error.message }).toString()}`);
    }
    throw error;
  }
  redirect(`/ai-answers?${new URLSearchParams({ done: request.done }).toString()}`);
}
