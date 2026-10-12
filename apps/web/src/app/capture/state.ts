import type { CaptureOutcome, IngestedMedia } from '../../lib/api/capture';

/**
 * What the capture form shows after a submission, and the gesture id its next submission carries.
 *
 * A recorded note rotates the gesture id, so the next note is a new gesture. A refused one keeps
 * it, so resubmitting the same note is a retry of the same gesture and cannot record twice — nor,
 * with a photo or voice note attached, store it twice: each ingest's key is the gesture and the
 * bytes' digest.
 */
export type CaptureState =
  | { readonly status: 'idle'; readonly gestureId: string }
  | {
      readonly status: 'recorded';
      readonly gestureId: string;
      readonly outcome: CaptureOutcome;
      readonly media?: readonly IngestedMedia[];
    }
  | { readonly status: 'refused'; readonly gestureId: string; readonly message: string };
