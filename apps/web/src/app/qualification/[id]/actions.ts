'use server';

import { redirect } from 'next/navigation';
import { act, ApiError } from '../../../lib/api';
import { webCaller } from '../../../lib/session';

/**
 * The institutional gestures on a qualification record (ADR 0038; SAS §24A, §100.62): withdraw
 * it, or record that a newer record supersedes it. Each is one act through
 * `POST /actions/:actionType`, as the signed-in person; the dispatcher and the database decide it
 * — act-grant coverage, the state machine, the reason — and a refusal comes back to the page as
 * the API's message. The page offers these only where the API said this reader may perform them;
 * nothing here re-decides that, and nothing here can make an act the API would refuse.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GESTURE = /^[A-Za-z0-9-]{8,48}$/;

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function back(recordId: string, outcome: { done: string } | { refused: string }): never {
  redirect(`/qualification/${recordId}?${new URLSearchParams(outcome).toString()}`);
}

async function perform(
  form: FormData,
  actionType: 'withdraw_qualification' | 'supersede_qualification',
  done: string,
): Promise<never> {
  const recordId = text(form, 'recordId').toLowerCase();
  if (!UUID.test(recordId)) redirect('/');
  const gesture = text(form, 'gestureId');
  if (!GESTURE.test(gesture)) back(recordId, { refused: 'This form has expired; reload it.' });
  const reason = text(form, 'reason');
  const supersededBy = text(form, 'supersededBy').toLowerCase();
  if (actionType === 'supersede_qualification' && !UUID.test(supersededBy)) {
    back(recordId, { refused: 'Choose the record that supersedes this one.' });
  }
  const caller = await webCaller(`/qualification/${recordId}`);
  try {
    await act(
      actionType,
      {
        targetIds: [recordId],
        ...(actionType === 'supersede_qualification'
          ? { payload: { superseded_by: supersededBy } }
          : {}),
        reason,
        idempotencyKey: `web-${actionType}-${gesture}`,
      },
      caller,
    );
  } catch (error: unknown) {
    if (error instanceof ApiError && error.isRefusal) back(recordId, { refused: error.message });
    throw error;
  }
  back(recordId, { done });
}

export async function withdrawQualification(form: FormData): Promise<void> {
  await perform(form, 'withdraw_qualification', 'Withdrawn. The reason is recorded with the act.');
}

export async function supersedeQualification(form: FormData): Promise<void> {
  await perform(
    form,
    'supersede_qualification',
    'Superseded. The newer record is the one in force.',
  );
}
