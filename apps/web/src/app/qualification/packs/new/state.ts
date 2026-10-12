/**
 * What the pack-drafting form shows after the person checks or drafts.
 *
 *   checked   the validator found nothing: the document may be drafted
 *   problems  the validator's own problems, by path, and nothing was sent
 *   refused   the API refused the act: its message, as it gave it
 *   drafted   the pack exists as a draft; approving it is an institutional act, not this page's
 *
 * The gesture id is the draft's idempotency: it changes only after a pack is drafted, so pressing
 * Draft twice replays the one act instead of drafting twice.
 */
export interface PackProblemView {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type PackFormState =
  | { readonly status: 'idle'; readonly gestureId: string }
  | { readonly status: 'checked'; readonly gestureId: string }
  | {
      readonly status: 'problems';
      readonly gestureId: string;
      readonly problems: readonly PackProblemView[];
    }
  | { readonly status: 'refused'; readonly gestureId: string; readonly message: string }
  | {
      readonly status: 'drafted';
      readonly gestureId: string;
      readonly packId: string;
      readonly replayed: boolean;
    };
