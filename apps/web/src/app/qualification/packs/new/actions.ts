'use server';

import { randomUUID } from 'node:crypto';
import { validatePackDocument, type PartRef, type ResolvedPart } from '@kf/qualification/pack';
import { act, ApiError } from '../../../../lib/api';
import { getPackDrafting } from '../../../../lib/api/qualification';
import { webCaller } from '../../../../lib/session';
import type { PackFormState } from './state';

/**
 * The pack-drafting form's one server action (ADR 0038; SAS §24A).
 *
 * `check` runs `@kf/qualification`'s `validatePackDocument` — the function
 * `draft_qualification_pack` runs — over the document, with part references resolved from the
 * API's own answer (`GET /qualification/packs/drafting`, read for this reader now, not taken from
 * the browser). `draft` does the same and, only when it finds nothing, dispatches
 * `draft_qualification_pack` through `POST /actions/:actionType`. The API stays the authority: it
 * validates again inside the act, and checks what only the record can say (roles, gated acts,
 * resources at their revisions), so a document this check passes can still be refused, and the
 * refusal is shown as the API gave it.
 *
 * Drafting approves nothing. Approval is `approve_qualification_pack`, an institutional act this
 * page does not offer.
 */

const PATH = '/qualification/packs/new';
const MAX_DOCUMENT = 256 * 1024;

export async function packGesture(previous: PackFormState, form: FormData): Promise<PackFormState> {
  const gestureId = previous.gestureId;
  const intent = form.get('intent') === 'draft' ? 'draft' : 'check';
  const text = form.get('document');
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_DOCUMENT) {
    return { status: 'refused', gestureId, message: 'The form sent no document.' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'refused', gestureId, message: 'The form sent a document that is not JSON.' };
  }
  const caller = await webCaller(PATH);
  let drafting;
  try {
    drafting = await getPackDrafting(caller);
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return { status: 'refused', gestureId, message: error.message };
    }
    throw error;
  }
  const parts = new Map(drafting.parts.map((p) => [`${p.key}@${String(p.revision)}`, p]));
  const validation = validatePackDocument(
    raw,
    (ref: PartRef) =>
      parts.get(`${ref.pack}@${String(ref.revision)}`) as unknown as ResolvedPart | undefined,
  );
  if (validation.problems.length > 0) {
    return {
      status: 'problems',
      gestureId,
      problems: validation.problems.map((p) => ({
        code: p.code,
        path: p.path,
        message: p.message,
      })),
    };
  }
  if (intent === 'check') return { status: 'checked', gestureId };
  if (!drafting.available) {
    return { status: 'refused', gestureId, message: 'You cannot draft a pack in this context.' };
  }
  try {
    const outcome = await act(
      'draft_qualification_pack',
      {
        targetIds: [],
        payload: { document: raw },
        idempotencyKey: `web-draft-pack-${gestureId}`,
      },
      caller,
    );
    const packId = outcome.objectIds[0];
    if (packId === undefined) {
      return { status: 'refused', gestureId, message: 'The API drafted no pack.' };
    }
    return { status: 'drafted', gestureId: randomUUID(), packId, replayed: outcome.replayed };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.isRefusal) {
      return { status: 'refused', gestureId, message: error.message };
    }
    throw error;
  }
}
