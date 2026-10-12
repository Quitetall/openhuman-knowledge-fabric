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

/**
 * The form, as the capture input. Tags are comma-separated; subjects are object ids. A note with a
 * photo or a voice note attached may be left empty: `mediaOnlyBody` says what was captured.
 */
export function captureInputFromForm(
  form: FormData,
  attached: readonly CaptureMedia[] = [],
): CaptureInput {
  const text = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const written = text('body');
  if (written.trim() === '' && attached.length === 0) {
    throw new CaptureInputRefused('Write the note, or attach a photo or a voice note.');
  }
  const body = written.trim() === '' ? mediaOnlyBody(attached) : written;
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

// ── A photo or a voice note, attached as evidence (ADR 0040 decision 10; KF-SAS-RQ-273) ──────
//
// A captured photo or voice note travels the one path a file takes into the Fabric:
// `POST /ingest`, which scans it, stores its bytes content-addressed in the object store, verifies
// the upload and dispatches `attach_evidence`, as the signed-in person. The observation then names
// each artifact among its subjects, so `record_observation` draws a `concerns` relation from the
// observation to it. The parser is not asked to read a photo or a recording (pandoc reads text
// formats only), so nothing is extracted from either.
//
// Nothing is transcribed and nothing is analysed. The media goes from the browser to this
// application and from here to the Fabric's API, and nowhere else: no speech service, no model.
// tests/conformance/capture-media-stays-on-host.test.ts holds that.

/** The photo formats a phone camera produces and a browser can show. */
export const PHOTO_MEDIA_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

/** What MediaRecorder produces (webm/opus, ogg, mp4/aac) and a phone's own recorder saves. */
export const VOICE_MEDIA_TYPES: readonly string[] = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/aac',
  'audio/wav',
  'audio/x-m4a',
];

/**
 * Everything attached to one capture, together. The web's server-action body limit is 11 MB
 * (`next.config.mjs`) and nginx's is 11m for the same reason; 10 MiB of media leaves room for the
 * note and the multipart framing. The API itself takes up to 20 MiB a file.
 */
export const MAX_CAPTURE_MEDIA_BYTES = 10 * 1024 * 1024;

export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;

/** The classifications a session may create: those at or below its ceiling. */
export function classificationsUpTo(ceiling: string): readonly string[] {
  const at = CLASSIFICATIONS.indexOf(ceiling as (typeof CLASSIFICATIONS)[number]);
  return at < 0 ? [] : CLASSIFICATIONS.slice(0, at + 1);
}

export interface CaptureMedia {
  readonly kind: 'photo' | 'voice';
  readonly name: string;
  /** The media type without parameters: `audio/webm;codecs=opus` is `audio/webm`. */
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** A file input left empty submits a nameless, empty File; it is not media. */
function filesOf(form: FormData, name: string): File[] {
  return form
    .getAll(name)
    .filter((value): value is File => value instanceof File && value.size > 0);
}

/** The photo and voice note on the form, refused here if a type or the total size is wrong. */
export async function captureMediaFromForm(form: FormData): Promise<readonly CaptureMedia[]> {
  const media: CaptureMedia[] = [];
  let total = 0;
  for (const [kind, accepted, label] of [
    ['photo', PHOTO_MEDIA_TYPES, 'a photo'],
    ['voice', VOICE_MEDIA_TYPES, 'a voice note'],
  ] as const) {
    const files = filesOf(form, kind);
    if (files.length > 1) throw new CaptureInputRefused(`Attach one ${kind} per observation.`);
    for (const file of files) {
      const mediaType = (file.type.split(';')[0] ?? '').trim().toLowerCase();
      if (!accepted.includes(mediaType)) {
        throw new CaptureInputRefused(
          `"${file.name}" is ${mediaType === '' ? 'of no stated type' : mediaType}, not ${label} ` +
            `this form takes (${accepted.join(', ')}).`,
        );
      }
      total += file.size;
      if (total > MAX_CAPTURE_MEDIA_BYTES) {
        throw new CaptureInputRefused(
          'The photo and voice note together are over 10 MiB; a shorter note or a smaller ' +
            'photo will fit.',
        );
      }
      media.push({
        kind,
        name: file.name.trim() === '' ? `${kind}` : file.name.trim().slice(0, 120),
        mediaType,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }
  }
  return media;
}

/** What the observation says when the person attached media and wrote nothing. */
export function mediaOnlyBody(media: readonly CaptureMedia[]): string {
  const kinds = media.map((m) => (m.kind === 'photo' ? 'a photo' : 'a voice note'));
  return `Captured ${kinds.join(' and ')}; see the attached evidence. Not transcribed.`;
}

export interface IngestedMedia {
  readonly kind: CaptureMedia['kind'];
  readonly artifactId: string;
  readonly sha256: string;
  readonly replayed: boolean;
}

/**
 * The `POST /ingest` body for one piece of media: spelled as the route spells it, with nothing
 * else. Its idempotency key is the gesture and the bytes' digest, and its title is the file's, so
 * a retried gesture replays the same act rather than storing the media twice.
 */
export function ingestRequestBody(
  media: CaptureMedia,
  input: { readonly gestureId: string; readonly classification: string; readonly sha256: string },
): Record<string, unknown> {
  return {
    title: `${media.kind === 'photo' ? 'Photo' : 'Voice note'}: ${media.name}`,
    artifactKind: 'other',
    classification: input.classification,
    mediaType: media.mediaType,
    contentBase64: Buffer.from(media.bytes).toString('base64'),
    idempotencyKey: `kf-capture-media-v1-${input.gestureId}-${input.sha256}`,
  };
}

export function parseIngestOutcome(value: unknown): { artifactId: string; replayed: boolean } {
  const v = record(value);
  if (v === undefined || typeof v['artifactId'] !== 'string' || !UUID.test(v['artifactId'])) {
    throw new Error('ingest response did not match its contract');
  }
  return { artifactId: v['artifactId'], replayed: v['replayed'] === true };
}

export async function ingestCaptureMedia(
  media: CaptureMedia,
  input: { readonly gestureId: string; readonly classification: string; readonly sha256: string },
  caller: Caller,
): Promise<IngestedMedia> {
  const response = await fetch(`${apiBaseUrl()}/ingest`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: JSON.stringify(ingestRequestBody(media, input)),
    cache: 'no-store',
  });
  const outcome = decodeSuccessfulResponse(await parseResponse(response), parseIngestOutcome);
  return { kind: media.kind, sha256: input.sha256, ...outcome };
}
