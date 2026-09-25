import { openContextHint } from './cookies';
import type { AuthorityContext, WebSession } from './types';

/** What the API said about a context: the same three answers a fresh selection gets. */
export type ContextCheck = 'confirmed' | 'refused' | 'unavailable';

export type ResumeOutcome =
  | { readonly kind: 'resumed'; readonly context: AuthorityContext }
  /** No hint for this subject: the person chooses, as on a first sign-in. */
  | { readonly kind: 'choose'; readonly discardHint: boolean };

/**
 * Offer a renewed session the context its person last chose, if the API still accepts it.
 *
 * The web never decides this. The hint says only which context to ASK about; `confirm` asks the
 * API with the new session's own bearer token, exactly as `/auth/context` does, so a role that
 * lapsed or a ceiling that was lowered since the choice is refused here as it would be there.
 * A hint belonging to another subject, or one the API refuses, is discarded; one the API could
 * not answer for is kept, because the person may renew again once it is back.
 */
export async function resumeChosenContext(
  hintCompact: string | undefined,
  session: WebSession,
  key: Uint8Array,
  confirm: (context: AuthorityContext) => Promise<ContextCheck>,
): Promise<ResumeOutcome> {
  if (hintCompact === undefined || hintCompact === '')
    return { kind: 'choose', discardHint: false };
  const context = await openContextHint(hintCompact, key, session.subject);
  if (context === undefined) return { kind: 'choose', discardHint: true };
  const check = await confirm(context);
  if (check === 'confirmed') return { kind: 'resumed', context };
  return { kind: 'choose', discardHint: check === 'refused' };
}
