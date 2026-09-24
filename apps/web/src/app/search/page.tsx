import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError, getSearchResults, type SearchResponse } from '../../lib/api';
import { webCaller } from '../../lib/session';
import { SearchResults } from './search-results';
import { parseSearchPageParams, type SearchPageParams } from './search-view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Search' };

export default async function SearchPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchPageParams>;
}) {
  const parsed = parseSearchPageParams(await searchParams);
  const caller = await webCaller('/search');
  let response: SearchResponse | undefined;
  let loadError: string | undefined;

  if (parsed.status === 'submitted' && parsed.request.text.trim() !== '') {
    try {
      response = await getSearchResults(caller, parsed.request);
    } catch (error: unknown) {
      loadError =
        error instanceof ApiError && error.status === 400
          ? 'Search text or filters were refused. Use exact machine names for filters.'
          : 'Search is temporarily unavailable.';
    }
  }

  const request = parsed.status === 'submitted' ? parsed.request : undefined;
  return (
    <main style={{ maxWidth: '72rem', margin: '0 auto', padding: '2.5rem 1.5rem 5rem' }}>
      <div style={{ maxWidth: '52rem' }}>
        <p style={{ color: '#64748b', margin: 0, fontSize: '0.85rem', letterSpacing: '0.04em' }}>
          CLASSIFICATION-AWARE CANONICAL SEARCH
        </p>
        <h1 style={{ margin: '0.25rem 0 0.5rem', fontSize: '2rem' }}>Search knowledge fabric</h1>
        <p style={{ color: '#475569', marginTop: 0 }}>
          Exact matches and, when the retrieval engine is running, records related by meaning —
          shown as two lists, each named by its ranking. Records above your clearance stay absent
          and uncounted; matching records within it that nobody has granted you are counted, never
          named. <Link href="/search/recorded">Your recorded queries</Link>.
        </p>
      </div>

      <form
        action="/search"
        method="get"
        style={{ display: 'grid', gap: '0.9rem', maxWidth: '52rem', marginTop: '1.5rem' }}
      >
        <label>
          <span>Search text</span>
          <input
            type="search"
            name="q"
            required
            maxLength={512}
            defaultValue={request?.text ?? ''}
            placeholder="Document title, subject, or partial identifier"
            className="kf-control"
          />
        </label>
        <div className="kf-responsive-grid">
          <label>
            <span>Object type (exact, optional)</span>
            <input
              name="objectType"
              maxLength={64}
              pattern="[a-z][a-z0-9_]*"
              defaultValue={request?.objectTypes?.[0] ?? ''}
              placeholder="controlled_document"
              className="kf-control"
            />
          </label>
          <label>
            <span>Lifecycle state (exact, optional)</span>
            <input
              name="lifecycleState"
              maxLength={64}
              pattern="[a-z][a-z0-9_]*"
              defaultValue={request?.lifecycleStates?.[0] ?? ''}
              placeholder="effective"
              className="kf-control"
            />
          </label>
        </div>
        <label style={{ maxWidth: '10rem' }}>
          <span>Result limit</span>
          <input
            type="number"
            name="limit"
            min={1}
            max={200}
            step={1}
            defaultValue={request?.limit ?? 50}
            className="kf-control"
          />
        </label>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            name="nearMisses"
            value="true"
            defaultChecked={request?.nearMisses === true}
          />
          <span>Also show near misses (records ranked just below the related list)</span>
        </label>
        <button type="submit" className="kf-button kf-button-primary">
          Search
        </button>
      </form>

      <section style={{ marginTop: '2.5rem' }} aria-labelledby="search-results-heading">
        <h2 id="search-results-heading" style={{ fontSize: '1.1rem' }}>
          Results
        </h2>
        {parsed.status === 'idle' ? (
          <p style={{ color: '#64748b' }}>Enter search text to query canonical records.</p>
        ) : parsed.status === 'invalid' ? (
          <p role="alert" aria-live="assertive" className="kf-status kf-status-error">
            Search URL contains malformed or oversized parameters.
          </p>
        ) : request?.text.trim() === '' ? (
          <p role="status" className="kf-status kf-status-neutral">
            Empty search returns no records.
          </p>
        ) : loadError !== undefined ? (
          <p role="status" aria-live="polite" className="kf-status kf-status-warning">
            {loadError}
          </p>
        ) : response === undefined ? null : (
          <SearchResults
            response={response}
            nearMissesRequested={request?.nearMisses === true}
            limit={request?.limit ?? 50}
          />
        )}
      </section>
    </main>
  );
}
