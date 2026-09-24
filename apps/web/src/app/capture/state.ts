import type { CaptureOutcome } from '../../lib/api/capture';

/**
 * What the capture form shows after a submission, and the gesture id its next submission carries.
 *
 * A recorded note rotates the gesture id, so the next note is a new gesture. A refused one keeps
 * it, so resubmitting the same note is a retry of the same gesture and cannot record twice.
 */
export type CaptureState =
  | { readonly status: 'idle'; readonly gestureId: string }
  | { readonly status: 'recorded'; readonly gestureId: string; readonly outcome: CaptureOutcome }
  | { readonly status: 'refused'; readonly gestureId: string; readonly message: string };
