import {
  apiBaseUrl,
  callerHeaders,
  decodeSuccessfulResponse,
  parseResponse,
  type Caller,
} from './client';
import { record } from './validation';
import { parseVerification, type Verification } from './verification';

/**
 * The web capture form's side of `POST /capture/observation` (ADR 0034, KF-SAS-RQ-200/203).
 *
 * This page reaches the one capture route every surface shares, and sends only what the route
 * accepts: the note, optional tags and subjects, and a gesture id. It sends no acting role, no
 * idempotency key and no row version in the body — the API forms them. The session's selected
 * role travels as the `x-kf-acting-role` header, as on every request this app makes, which is
 * the person having named it once at sign-in rather than on every note.
 */

/** Everything this page may send; the API refuses any other body field. */
export interface CaptureInput {
  readonly body: string;
  readonly tags?: readonly string[];
  readonly subjects?: readonly string[];
  /** One per rendered form: a double submit of the same form replays instead of recording twice. */
  readonly gestureId: string;
}

export interface CaptureOutcome {
  readonly observationId: string;
  readonly actionId: string;
  readonly replayed: boolean;
  readonly gestureId: string;
  readonly lifecycleState: string;
  readonly verification: Verification;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CaptureInputRefused extends Error {}

/** The form, as the capture input. Tags are comma-separated; subjects are object ids. */
export function captureInputFromForm(form: FormData): CaptureInput {
  const text = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const body = text('body');
  if (body.trim() === '') throw new CaptureInputRefused('Write the note first.');
  const gestureId = text('gestureId');
  if (!/^[A-Za-z0-9._:-]{8,48}$/u.test(gestureId)) {
    throw new CaptureInputRefused('This form has expired. Reload the page and try again.');
  }
  const list = (name: string): string[] =>
    text(name)
      .split(/[,\s]+/u)
      .map((item) => item.trim())
      .filter((item) => item !== '');
  const tags = list('tags');
  const subjects = list('subjects');
  const invalid = subjects.find((id) => !UUID.test(id));
  if (invalid !== undefined) {
    throw new CaptureInputRefused(`"${invalid}" is not an object id.`);
  }
  return {
    body,
    gestureId,
    ...(tags.length === 0 ? {} : { tags }),
    ...(subjects.length === 0 ? {} : { subjects }),
  };
}

/** The request body, spelled as the route spells it. Nothing else is ever added here. */
export function captureRequestBody(input: CaptureInput): Record<string, unknown> {
  return {
    body: input.body,
    gesture_id: input.gestureId,
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
    ...(input.subjects === undefined ? {} : { subjects: [...input.subjects] }),
  };
}

/**
 * The API's answer. The verification is parsed fail-closed (`parseVerification`): an answer that
 * does not prove the observation verified is shown as unverified, never the other way round.
 */
export function parseCaptureOutcome(value: unknown): CaptureOutcome {
  const v = record(value);
  if (
    v === undefined ||
    typeof v['observationId'] !== 'string' ||
    typeof v['actionId'] !== 'string' ||
    typeof v['replayed'] !== 'boolean' ||
    typeof v['gestureId'] !== 'string' ||
    typeof v['lifecycleState'] !== 'string'
  ) {
    throw new Error('capture response did not match its contract');
  }
  return {
    observationId: v['observationId'],
    actionId: v['actionId'],
    replayed: v['replayed'],
    gestureId: v['gestureId'],
    lifecycleState: v['lifecycleState'],
    verification: parseVerification(v['verification']),
  };
}

export async function captureObservation(
  input: CaptureInput,
  caller: Caller,
): Promise<CaptureOutcome> {
  const response = await fetch(`${apiBaseUrl()}/capture/observation`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: JSON.stringify(captureRequestBody(input)),
    cache: 'no-store',
  });
  return decodeSuccessfulResponse(await parseResponse(response), parseCaptureOutcome);
}
