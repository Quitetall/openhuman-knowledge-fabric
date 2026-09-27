/**
 * Reading the Object View, and when a stale master record may be refreshed without a click.
 *
 * `GET /objects/:id` never compiles: a stale master record is answered `409 master_record_stale`,
 * because compiling is an act recorded as the viewer, and a GET is what any site can send them
 * to. Until 2026-09-23 the page then always asked for a click — including when the person had
 * typed the address, followed a bookmark, or clicked a link inside the fabric itself, where the
 * intent is theirs and the button is only friction.
 *
 * The browser says which it is. `Sec-Fetch-Site` on the page request is set by the browser, not
 * by page script, and cannot be forged by a cross-site page:
 *
 *   same-origin   a link or form inside this site         -> refresh, then render
 *   none          typed, bookmarked, opened from history  -> refresh, then render
 *   same-site     another subdomain of this site           -> ask
 *   cross-site    any other site                           -> ask
 *   (absent)      an old browser, or not a browser          -> ask
 *
 * A prefetch is never intent, whatever its site: Next.js and browsers prefetch links the person
 * has not followed, so a request marked as one asks rather than acting.
 */

import type { ObjectView } from '../../../lib/api';

export interface NavigationHeaders {
  get(name: string): string | null;
}

export function isOwnNavigation(headers: NavigationHeaders): boolean {
  const purpose = `${headers.get('sec-purpose') ?? ''} ${headers.get('purpose') ?? ''}`;
  if (headers.get('next-router-prefetch') !== null || /prefetch/i.test(purpose)) return false;
  const site = headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none';
}

export type ObjectViewOutcome =
  | { readonly kind: 'view'; readonly view: ObjectView; readonly refreshed: boolean }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly error: unknown };

function isStale(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'master_record_stale'
  );
}

/**
 * Read the view; on a stale master record, refresh it (a POST, recorded as the person) only
 * when this request is the person's own navigation. Otherwise report `stale` so the page can
 * ask. A refresh that itself fails is a failure, not a silent fallback to asking.
 */
export async function loadObjectView(
  headers: NavigationHeaders,
  read: () => Promise<ObjectView>,
  refresh: () => Promise<ObjectView>,
): Promise<ObjectViewOutcome> {
  try {
    return { kind: 'view', view: await read(), refreshed: false };
  } catch (error: unknown) {
    if (!isStale(error)) return { kind: 'failed', error };
    if (!isOwnNavigation(headers)) return { kind: 'stale' };
  }
  try {
    return { kind: 'view', view: await refresh(), refreshed: true };
  } catch (error: unknown) {
    return { kind: 'failed', error };
  }
}
