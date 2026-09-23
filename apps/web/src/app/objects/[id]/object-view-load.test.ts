/**
 * A stale master record is refreshed without a click for the person's own navigation, and only
 * then. `GET /objects/:id` stays side-effect free; what changes is whether the PAGE, having been
 * asked for by the person, performs the refresh POST for them.
 */

import { describe, expect, it } from 'vitest';
import { ApiError, type ObjectView } from '../../../lib/api';
import { isOwnNavigation, loadObjectView } from './object-view-load';

const VIEW = { projectionDigest: 'p', corpusDigest: 'c' } as unknown as ObjectView;
const stale = () => new ApiError(409, 'master_record_stale', 'stale', undefined);

function request(values: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

async function load(values: Record<string, string>) {
  let refreshes = 0;
  const outcome = await loadObjectView(
    request(values),
    () => Promise.reject(stale()),
    () => {
      refreshes += 1;
      return Promise.resolve(VIEW);
    },
  );
  return { outcome, refreshes };
}

describe('a stale master record', () => {
  it.each(['same-origin', 'none'])(
    'is refreshed and rendered for Sec-Fetch-Site: %s — the person asked for this page',
    async (site) => {
      const { outcome, refreshes } = await load({ 'Sec-Fetch-Site': site });
      expect(refreshes).toBe(1);
      expect(outcome).toEqual({ kind: 'view', view: VIEW, refreshed: true });
    },
  );

  it.each([['cross-site'], ['same-site'], [undefined]])(
    'asks, and records nothing, for Sec-Fetch-Site: %s',
    async (site) => {
      const { outcome, refreshes } = await load(
        site === undefined ? {} : { 'Sec-Fetch-Site': site },
      );
      expect(refreshes).toBe(0);
      expect(outcome).toEqual({ kind: 'stale' });
    },
  );

  it('asks for a prefetch even from this site: a prefetch is not the person following a link', async () => {
    for (const headers of [
      { 'Sec-Fetch-Site': 'same-origin', 'Next-Router-Prefetch': '1' },
      { 'Sec-Fetch-Site': 'same-origin', 'Sec-Purpose': 'prefetch' },
      { 'Sec-Fetch-Site': 'none', Purpose: 'prefetch' },
    ]) {
      const { refreshes } = await load(headers);
      expect(refreshes, JSON.stringify(headers)).toBe(0);
    }
  });
});

describe('everything else', () => {
  it('renders a current record without refreshing it', async () => {
    let refreshes = 0;
    const outcome = await loadObjectView(
      request({ 'Sec-Fetch-Site': 'same-origin' }),
      () => Promise.resolve(VIEW),
      () => {
        refreshes += 1;
        return Promise.resolve(VIEW);
      },
    );
    expect(outcome).toEqual({ kind: 'view', view: VIEW, refreshed: false });
    expect(refreshes).toBe(0);
  });

  it('reports a failure other than staleness without refreshing', async () => {
    const refused = new ApiError(403, 'forbidden', 'no', undefined);
    const outcome = await loadObjectView(
      request({ 'Sec-Fetch-Site': 'same-origin' }),
      () => Promise.reject(refused),
      () => Promise.reject(new Error('must not refresh')),
    );
    expect(outcome).toEqual({ kind: 'failed', error: refused });
  });

  it('reports a failed refresh as a failure, not as a request to ask', async () => {
    const broken = new Error('refresh failed');
    const outcome = await loadObjectView(
      request({ 'Sec-Fetch-Site': 'none' }),
      () => Promise.reject(stale()),
      () => Promise.reject(broken),
    );
    expect(outcome).toEqual({ kind: 'failed', error: broken });
  });

  it('reads the header case-insensitively, as a Headers object does', () => {
    expect(isOwnNavigation(new Headers({ 'SEC-FETCH-SITE': 'same-origin' }))).toBe(true);
  });
});

describe('the Object View page', () => {
  it('decides through loadObjectView with the page request’s own headers', async () => {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
    expect(page).toContain('await loadObjectView(\n    await headers(),');
    // The only other refresh is the server action behind the button: a POST the person sent.
    const refreshes = page.split('refreshObjectView(').length - 1;
    expect(refreshes).toBe(2);
    expect(page).toMatch(/async function refresh\(\): Promise<void> \{\n\s+'use server';/);
  });
});
