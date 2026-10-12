'use server';

import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../../lib/api';
import {
  CaptureInputRefused,
  captureInputFromForm,
  captureMediaFromForm,
  captureObservation,
  classificationsUpTo,
  ingestCaptureMedia,
  type CaptureMedia,
  type IngestedMedia,
} from '../../lib/api/capture';
import { webCaller } from '../../lib/session';
import type { CaptureState } from './state';

/**
 * The capture form's one server action. A note alone is `POST /capture/observation` and nothing
 * else. With a photo or a voice note, each is first `POST /ingest` (stored, verified, recorded by
 * `attach_evidence` as evidence) and the observation then names it among its subjects. Both are
 * the person's own acts, through the API's ordinary seams; this action writes nothing itself and
 * sends the media nowhere but the API. Nothing is transcribed.
 *
 * If the observation is refused after the media was stored, the media stays as evidence the
 * person attached, and the same gesture retried replays its ingest and records the observation.
 */
export async function captureNote(previous: CaptureState, form: FormData): Promise<CaptureState> {
  let input;
  let media: readonly CaptureMedia[];
  try {
    media = await captureMediaFromForm(form);
    input = captureInputFromForm(form, media);
  } catch (error: unknown) {
    if (error instanceof CaptureInputRefused) {
      return { status: 'refused', gestureId: previous.gestureId, message: error.message };
    }
    throw error;
  }
  const caller = await webCaller('/capture');
  const classification = form.get('classification');
  if (
    media.length > 0 &&
    (typeof classification !== 'string' ||
      !classificationsUpTo(caller.maxClassification).includes(classification))
  ) {
    return {
      status: 'refused',
      gestureId: input.gestureId,
      message: 'Choose how the photo or voice note is classified, at or below your clearance.',
    };
  }
  try {
    const ingested: IngestedMedia[] = [];
    for (const item of media) {
      ingested.push(
        await ingestCaptureMedia(
          item,
          {
            gestureId: input.gestureId,
            classification: String(classification),
            sha256: createHash('sha256').update(item.bytes).digest('hex'),
          },
          caller,
        ),
      );
    }
    const subjects = [...(input.subjects ?? []), ...ingested.map((m) => m.artifactId)];
    const outcome = await captureObservation(
      { ...input, ...(subjects.length === 0 ? {} : { subjects }) },
      caller,
    );
    return {
      status: 'recorded',
      gestureId: randomUUID(),
      outcome,
      ...(ingested.length === 0 ? {} : { media: ingested }),
    };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.isRefusal) {
      return { status: 'refused', gestureId: input.gestureId, message: error.message };
    }
    throw error;
  }
}
