import type { Metadata } from 'next';
import Link from 'next/link';
import { formatState } from '@kf/ui';
import { getOwnRecordedQueries, type OwnRecordedQuery } from '../../../lib/api';
import { webCaller } from '../../../lib/session';
import { DemandForm } from './demand-form';
import { ReplayForm } from './replay-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your recorded queries' };

/**
 * `/search/recorded` — the reader's own recorded queries, and a replay of each (KF-SAS-RQ-221).
 *
 * The list is the API's, which returns only queries the reader asked. A query is a transient
 * observation: it expires after its window, and so does its place on this page.
 */
export default async function RecordedQueriesPage() {
  const caller = await webCaller('/search/recorded');
  let queries: readonly OwnRecordedQuery[] = [];
  let loadError: string | undefined;
  try {
    queries = await getOwnRecordedQueries(caller);
  } catch {
    loadError = 'Your recorded queries are temporarily unavailable.';
  }
  return (
    <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '2.5rem 1.5rem 5rem' }}>
      <div style={{ maxWidth: '52rem' }}>
        <p style={{ color: '#64748b', margin: 0, fontSize: '0.85rem', letterSpacing: '0.04em' }}>
          YOUR QUERIES, NOBODY ELSE&apos;S
        </p>
        <h1 style={{ margin: '0.25rem 0 0.5rem', fontSize: '2rem' }}>Your recorded queries</h1>
        <p style={{ color: '#475569', marginTop: 0 }}>
          Searches you ran in the last 90 days, kept without your name and then deleted. Replaying
          one runs it again at your clearance now and shows what the clearance you asked at
          withheld; each such record counts once toward how many people want access to it, never
          who. <Link href="/search">Back to search</Link>.
        </p>
      </div>
      <section style={{ marginTop: '2rem' }} aria-labelledby="recorded-heading">
        <h2 id="recorded-heading" style={{ fontSize: '1.1rem' }}>
          Recorded
        </h2>
        {loadError !== undefined ? (
          <p role="status" className="kf-status kf-status-warning">
            {loadError}
          </p>
        ) : queries.length === 0 ? (
          <p role="status" className="kf-status kf-status-neutral">
            No recorded queries in the current window.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.75rem' }}>
            {queries.map((query) => (
              <li
                key={query.id}
                style={{ border: '1px solid #cbd5e1', borderRadius: '0.65rem', padding: '1rem' }}
              >
                <p style={{ margin: 0, fontWeight: 600 }}>{query.text}</p>
                <p style={{ color: '#64748b', margin: '0.3rem 0 0.6rem', fontSize: '0.85rem' }}>
                  Asked at {formatState(query.askerCeiling)} ·{' '}
                  <time dateTime={query.recordedAt}>
                    {query.recordedAt.slice(0, 16).replace('T', ' ')}
                  </time>{' '}
                  UTC · expires{' '}
                  <time dateTime={query.expiresAt}>{query.expiresAt.slice(0, 10)}</time>
                </p>
                <ReplayForm recordedQueryId={query.id} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section style={{ marginTop: '2.5rem', maxWidth: '52rem' }} aria-labelledby="demand-heading">
        <h2 id="demand-heading" style={{ fontSize: '1.1rem' }}>
          Demand from people cleared lower
        </h2>
        <p style={{ color: '#475569', marginTop: 0 }}>
          Runs, at your clearance, every recorded query asked below it, and counts each record the
          asker&apos;s clearance withheld toward how many distinct people want access to it. You are
          shown the records you can read and those counts — never what anybody typed, when, or who
          they are.
        </p>
        <DemandForm />
      </section>
    </main>
  );
}
