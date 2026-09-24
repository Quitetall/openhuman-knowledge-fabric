import type { DemandReplay, RecordedQueryReplay } from '../../../lib/api';

/**
 * What one replay button shows after it is pressed. The replay's result is held in the page only:
 * what a ceiling withheld is computed on demand and never stored (KF-SAS-RQ-222).
 */
export type ReplayState =
  | { readonly status: 'idle' }
  | { readonly status: 'replayed'; readonly replay: RecordedQueryReplay }
  | { readonly status: 'refused'; readonly message: string };

/** What the demand replay button shows after it is pressed. Held in the page only. */
export type DemandState =
  { readonly status: 'idle' } | { readonly status: 'replayed'; readonly replay: DemandReplay };
