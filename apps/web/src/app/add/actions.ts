'use server';

import { ApiError } from '../../lib/api';
import { addFile, addFileProblem } from '../../lib/api/add';
import { CaptureInputRefused } from '../../lib/api/capture';
import { webCaller } from '../../lib/session';
import { plainReason, type AddOutcome } from './result';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * One file, one request, one act. The page sends its files one at a time so each gets its own
 * answer and no request carries more than one file. This action writes nothing itself: it asks
 * the API, as the signed-in person, and reports what the API said.
 */
export async function addOneFile(form: FormData): Promise<AddOutcome> {
  const file = form.get('file');
  const name = file instanceof File && file.name.trim() !== '' ? file.name.trim() : 'Unnamed file';
  const refuse = (code: string, message: string): AddOutcome => ({
    status: 'refused',
    name,
    code,
    reason: plainReason(code, message),
  });
  if (!(file instanceof File)) return refuse('empty_file', '');
  const caller = await webCaller('/add');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const classification = text(form, 'classification');
  const problem = addFileProblem({ bytes, classification }, caller.maxClassification);
  if (problem !== undefined) return refuse(problem.code, problem.message);
  try {
    const outcome = await addFile(
      {
        name,
        statedType: file.type,
        bytes,
        classification,
        note: text(form, 'note'),
      },
      caller,
    );
    return { status: 'added', name, artifactId: outcome.artifactId, replayed: outcome.replayed };
  } catch (error: unknown) {
    if (error instanceof CaptureInputRefused) return refuse('note_too_long', error.message);
    if (error instanceof ApiError && error.isRefusal) return refuse(error.code, error.message);
    return refuse('unavailable', '');
  }
}
