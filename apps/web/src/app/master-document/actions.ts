'use server';

import { redirect } from 'next/navigation';
import { ApiError } from '../../lib/api';
import { compileMasterRecord } from '../../lib/api/experience';
import { webCaller } from '../../lib/session';

/**
 * "Compile now": `POST /master-record/compile`, an act recorded as the person. The key arrives
 * with the form, formed once when the page was rendered, so a double submit replays rather than
 * compiling twice.
 */
export async function compileNow(form: FormData): Promise<void> {
  const key = form.get('idempotencyKey');
  const caller = await webCaller('/master-document');
  let outcome = 'compiled';
  try {
    const result = await compileMasterRecord(
      caller,
      typeof key === 'string' && key.length >= 8 ? key : undefined,
    );
    if (result.reused) outcome = 'unchanged';
  } catch (error: unknown) {
    if (!(error instanceof ApiError && error.isRefusal)) throw error;
    outcome = 'refused';
  }
  redirect(`/master-document?compiled=${outcome}`);
}
