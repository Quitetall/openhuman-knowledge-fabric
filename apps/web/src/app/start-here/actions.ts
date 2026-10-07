'use server';

import { redirect } from 'next/navigation';
import { ApiError } from '../../lib/api';
import { creditEvidence, submitEvidence } from '../../lib/api/qualification';
import { webCaller } from '../../lib/session';

/**
 * The person's own gestures on Start Here (ADR 0038). Each is one API call that dispatches one
 * act; the database decides it. A refusal comes back to the page as its message.
 *
 *   acknowledge  a self-acknowledged requirement: "received and reviewed", naming the resource
 *   submit       name a record as evidence; it credits nothing, a reviewer does
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

async function answered(gesture: () => Promise<unknown>, done: string): Promise<never> {
  try {
    await gesture();
  } catch (error: unknown) {
    if (error instanceof ApiError && error.isRefusal) {
      redirect(`/start-here?${new URLSearchParams({ refused: error.message }).toString()}`);
    }
    throw error;
  }
  redirect(`/start-here?${new URLSearchParams({ done }).toString()}`);
}

export async function acknowledgeRequirement(form: FormData): Promise<void> {
  const caller = await webCaller('/start-here');
  await answered(
    () =>
      creditEvidence(caller, text(form, 'recordId'), {
        credits: [
          {
            requirementKey: text(form, 'requirementKey'),
            evidenceObjectId: text(form, 'evidenceObjectId'),
          },
        ],
        idempotencyKey: text(form, 'idempotencyKey'),
      }),
    'Acknowledged: received and reviewed.',
  );
}

export async function submitRequirementEvidence(form: FormData): Promise<void> {
  const caller = await webCaller('/start-here');
  const evidence = text(form, 'evidenceObjectId').toLowerCase();
  if (!UUID.test(evidence)) {
    redirect(
      `/start-here?${new URLSearchParams({ refused: 'Evidence is a record id, a uuid.' }).toString()}`,
    );
  }
  await answered(
    () =>
      submitEvidence(caller, text(form, 'recordId'), {
        requirementKey: text(form, 'requirementKey'),
        evidenceObjectId: evidence,
        idempotencyKey: text(form, 'idempotencyKey'),
      }),
    'Submitted. A reviewer credits it from Needs you.',
  );
}
