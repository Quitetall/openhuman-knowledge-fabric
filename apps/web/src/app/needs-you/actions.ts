'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { ApiError } from '../../lib/api';
import { confirmProposal, declineProposal, verifyMany, verifyOne } from '../../lib/api/needs-you';
import { webCaller } from '../../lib/session';

/**
 * The Needs-you panel's gestures (ADR 0040). Each is one API call; the API dispatches the act and
 * the database decides. A refusal comes back to the page as its message, never swallowed.
 *
 * `returnTo` is where the panel is hosted (this page, or M3's dashboard), checked to be a path on
 * this site so a form cannot be made to redirect elsewhere.
 */

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function back(form: FormData, outcome: { ok?: string; refused?: string }): never {
  const target = text(form, 'returnTo');
  const path = /^\/[A-Za-z0-9/_-]*$/u.test(target) ? target : '/needs-you';
  const query = new URLSearchParams(
    outcome.ok === undefined ? { refused: outcome.refused ?? '' } : { done: outcome.ok },
  );
  redirect(`${path}?${query.toString()}`);
}

async function answered(form: FormData, gesture: () => Promise<unknown>, done: string) {
  try {
    await gesture();
  } catch (error: unknown) {
    if (error instanceof ApiError && error.isRefusal) back(form, { refused: error.message });
    throw error;
  }
  back(form, { ok: done });
}

export async function verifyRecord(form: FormData): Promise<void> {
  const caller = await webCaller('/needs-you');
  await answered(
    form,
    () =>
      verifyOne(caller, {
        recordId: text(form, 'recordId'),
        expectedVersion: Number(text(form, 'expectedVersion')),
        reason: text(form, 'reason'),
        idempotencyKey: text(form, 'gestureId') || randomUUID(),
      }),
    'Verified, as reviewed individually.',
  );
}

export async function verifySelected(form: FormData): Promise<void> {
  const caller = await webCaller('/needs-you');
  const recordIds = form.getAll('recordIds').filter((v): v is string => typeof v === 'string');
  if (recordIds.length === 0) back(form, { refused: 'Select the records to verify first.' });
  await answered(
    form,
    () =>
      verifyMany(caller, {
        recordIds,
        reason: text(form, 'reason'),
        idempotencyKey: text(form, 'gestureId') || randomUUID(),
      }),
    `Verified ${String(recordIds.length)}, recorded as promoted in bulk.`,
  );
}

export async function confirmProposed(form: FormData): Promise<void> {
  const caller = await webCaller('/needs-you');
  await answered(
    form,
    () => confirmProposal(caller, text(form, 'proposalId')),
    'Performed, as your own act.',
  );
}

export async function declineProposed(form: FormData): Promise<void> {
  const caller = await webCaller('/needs-you');
  await answered(
    form,
    () =>
      declineProposal(caller, text(form, 'proposalId'), {
        reason: text(form, 'reason'),
        idempotencyKey: text(form, 'gestureId') || randomUUID(),
      }),
    'Declined.',
  );
}
