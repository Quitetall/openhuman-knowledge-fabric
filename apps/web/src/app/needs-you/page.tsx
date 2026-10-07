import type { Metadata } from 'next';
import { getNeedsYou } from '../../lib/api/needs-you';
import { webCaller } from '../../lib/session';
import { NeedsYouPanel } from './needs-you-panel';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Needs you' };

/**
 * `/needs-you` — the Needs-you panel on a page of its own. The dashboard hosts the same panel in
 * its Needs-you slot (`components/needs-you-slot.tsx`); this page is its full-width reading.
 */
export default async function NeedsYouPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await webCaller('/needs-you');
  const data = await getNeedsYou(caller);
  const params = await searchParams;
  const done = typeof params['done'] === 'string' ? params['done'] : undefined;
  const refused = typeof params['refused'] === 'string' ? params['refused'] : undefined;
  return (
    <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '1.5rem 1rem 4rem' }}>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.75rem' }}>Needs you</h1>
      {done === undefined ? null : <p role="status">{done}</p>}
      {refused === undefined ? null : <p role="alert">Refused: {refused}</p>}
      <NeedsYouPanel data={data} />
    </main>
  );
}
