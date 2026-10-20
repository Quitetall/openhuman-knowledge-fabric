import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError, getSearchResults, type SearchResponse } from '../../lib/api';
import { webCaller } from '../../lib/session';
import { SearchResults } from './search-results';
import { MeaningSwitch } from '../components/meaning-switch';
import {
  parseSearchPageParams,
  searchByMeaning,
  searchReturnPath,
  type SearchPageParams,
} from './search-view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Search' };

export default async function SearchPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchPageParams>;
}) {
  const params = await searchParams;
  const parsed = parseSearchPageParams(params);
  const caller = await webCaller(searchReturnPath(params));
  let response: SearchResponse | undefined;
  let loadError: string | undefined;

  if (parsed.status === 'submitted' && parsed.request.text.trim() !== '') {
    try {
      response = await getSearchResults(caller, parsed.request);
    } catch (error: unknown) {
      loadError =
        error instanceof ApiError && error.status === 400
          ? 'Those filters were not accepted. A kind or state is one word, like controlled_document.'
          : 'Search isn’t working right now. Try again in a minute.';
    }
  }

  const request = parsed.status === 'submitted' ? parsed.request : undefined;
  const meaning =
    parsed.status === 'submitted' ? parsed.meaning : (searchByMeaning(params['meaning']) ?? true);
  const filtered =
    request?.objectTypes !== undefined ||
    request?.lifecycleStates !== undefined ||
    request?.nearMisses === true ||
    (request?.limit !== undefined && request.limit !== 50);
  return (
    <main className="kf-page">
      <h1 className="kf-title">Search</h1>
      <form action="/search" method="get" className="kf-searchform" role="search">
        <label htmlFor="search-q" className="kf-sr-only">
          Search your records
        </label>
        <div className="kf-searchbar">
          <input
            id="search-q"
            type="search"
            name="q"
            required
            maxLength={512}
            defaultValue={request?.text ?? ''}
            placeholder="Words, a title, a part number…"
            className="kf-control kf-control-large"
          />
          <button type="submit" className="kf-button kf-button-primary kf-button-large">
            Search
          </button>
        </div>
        <MeaningSwitch on={meaning} />
        <details className="kf-filters" open={filtered}>
          <summary>Filters</summary>
          <div className="kf-responsive-grid">
            <label>
              <span>Kind of record</span>
              <input
                name="objectType"
                maxLength={64}
                pattern="[a-z][a-z0-9_]*"
                defaultValue={request?.objectTypes?.[0] ?? ''}
                placeholder="for example controlled_document"
                className="kf-control"
              />
            </label>
            <label>
              <span>State</span>
              <input
                name="lifecycleState"
                maxLength={64}
                pattern="[a-z][a-z0-9_]*"
                defaultValue={request?.lifecycleStates?.[0] ?? ''}
                placeholder="for example effective"
                className="kf-control"
              />
            </label>
          </div>
          <label className="kf-filter-limit">
            <span>How many results</span>
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
          <label className="kf-check">
            <input
              type="checkbox"
              name="nearMisses"
              value="true"
              defaultChecked={request?.nearMisses === true}
            />
            <span>Also show near misses (records just below the related ones)</span>
          </label>
        </details>
      </form>

      <section className="kf-search-answer" aria-label="Results">
        {parsed.status === 'idle' ? (
          <p className="kf-muted">
            Type what you are looking for. You will only see records you have access to.{' '}
            <Link href="/search/recorded">Your past searches</Link>
          </p>
        ) : parsed.status === 'invalid' ? (
          <p role="alert" aria-live="assertive" className="kf-status kf-status-error">
            That search could not be read. Clear the filters and try again.
          </p>
        ) : request?.text.trim() === '' ? (
          <p role="status" className="kf-status kf-status-neutral">
            Type some words to search.
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
            meaning={meaning}
          />
        )}
      </section>
    </main>
  );
}
