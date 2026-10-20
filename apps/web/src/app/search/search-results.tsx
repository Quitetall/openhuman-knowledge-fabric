import Link from 'next/link';
import { formatState } from '@kf/ui';
import type { RankedSearchHit, SearchHit, SearchResponse, SemanticSearchHit } from '../../lib/api';
import { classificationWords } from '../../lib/auth/identity-label';
import { Badge } from '../components/badge';
import { VerificationChip } from '../components/state-chip';
import { meaningUnavailable, recordHref, searchPageHref, shownList } from './search-view';

/**
 * The composed search answer (KF-SAS-RQ-224, RQ-216, RQ-217, ADR 0037), in words a person reads.
 *
 * One list first: the fused list, each result a card with its title, what kind of record it is,
 * its state, whether anybody has verified it, when it last changed and a passage of its text. How
 * the list was ranked — the fusion's name and where each ranking placed every result — is kept,
 * folded, under "How this was ranked", so a merely similar record can still be told from a word
 * match by anyone who asks. The two source lists follow, folded, each under its ranking's name.
 * Near misses appear only when asked for, labelled as what they are.
 *
 * The "Search by meaning" switch (`meaning`) chooses the list read first: on, the fused list; off,
 * every record that holds the words (the lexical list), and nothing ranked by meaning beside it.
 *
 * Two things are never folded away, because they are rules and not decoration: how many matching
 * records the person may not see (a count, never a title), and that matching by meaning was
 * unavailable when it was asked for.
 */

/** ADR 0037's disclosure, in words: a count within the caller's ceiling, and nothing else. */
export function withheldCountSentence(count: number): string | undefined {
  if (count === 0) return undefined;
  const records = count === 1 ? '1 more matching record' : `${count} more matching records`;
  return (
    `${records} ${count === 1 ? 'exists that you don’t' : 'exist that you don’t'} have access to, ` +
    `so ${count === 1 ? 'it isn’t' : 'they aren’t'} shown. Ask for access if you need ` +
    `${count === 1 ? 'it' : 'them'}. Records marked above what you can see are never counted.`
  );
}

type AnyHit = SearchHit | SemanticSearchHit | RankedSearchHit;

/** Where the two rankings placed a fused result, in words. */
export function placesSentence(hit: RankedSearchHit): string {
  const places: string[] = [];
  if (hit.lexical !== undefined) {
    places.push(
      `${hit.lexical.matchedBy === 'full_text' ? 'Word match' : 'Partial-identifier match'} #${hit.lexical.rank}`,
    );
  }
  if (hit.semantic !== undefined) places.push(`Related by meaning #${hit.semantic.rank}`);
  return places.join(' · ');
}

/** "Updated 3 Oct 2026", in UTC so two readers quoting it agree. */
export function updatedWords(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return `Updated ${date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })}`;
}

/** What kind of record, as a word: `decision_record` → "Decision record". */
export function kindWords(objectType: string): string {
  const words = formatState(objectType).trim();
  return words === '' ? objectType : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

/** One result: what a person needs to decide whether to open it. */
export function HitCard({ hit, detail }: { readonly hit: AnyHit; readonly detail?: string }) {
  const href = recordHref(hit.objectType, hit.objectId);
  const updated = updatedWords(hit.updatedAt);
  return (
    <article className="kf-hit" data-object-type={hit.objectType} data-object-id={hit.objectId}>
      <h3 className="kf-hit-title">
        <Link href={href}>{hit.title}</Link>
      </h3>
      <p className="kf-hit-meta">
        <span>{kindWords(hit.objectType)}</span>
        <Badge state={hit.lifecycleState} />
        <VerificationChip verification={hit.verification} />
        {updated === undefined ? null : <span data-updated={hit.updatedAt}>{updated}</span>}
        <span
          className="kf-hit-audience"
          data-classification={hit.classification}
          title="Who can see this record"
        >
          {classificationWords(hit.classification)}
        </span>
      </p>
      {hit.excerpt === undefined ? null : <p className="kf-hit-excerpt">{hit.excerpt}</p>}
      {detail === undefined ? null : <p className="kf-hit-detail">{detail}</p>}
    </article>
  );
}

function RankingName({ ranking }: { readonly ranking: string }) {
  return (
    <p className="kf-ranking-name">
      Ranking: <code data-ranking={ranking}>{ranking}</code>
    </p>
  );
}

/**
 * The two notices that stay visible whatever is folded. The withheld count is the API's, unchanged
 * by the switch: it is counted over the word-match set, so it is true beside either list. That
 * meaning was unavailable is said only when the person asked for it; why is in the fold.
 */
export function SearchNotices({
  response,
  meaning = true,
}: {
  readonly response: SearchResponse;
  readonly meaning?: boolean;
}) {
  const withheldSentence = withheldCountSentence(response.withheldCount);
  return (
    <>
      {withheldSentence === undefined ? null : (
        <p
          role="status"
          className="kf-status kf-status-neutral"
          data-withheld-count={response.withheldCount}
        >
          {withheldSentence}
        </p>
      )}
      {meaning && meaningUnavailable(response) ? (
        <p
          role="status"
          className="kf-status kf-status-warning"
          data-withholding="semantic_ranking_unavailable"
        >
          Search by meaning isn’t available right now — showing exact-word matches.
        </p>
      ) : null}
    </>
  );
}

/** Nothing matched: say so, and what to do next. */
export function NoResults() {
  return (
    <div role="status" className="kf-empty">
      <p>Nothing you can see matches those words.</p>
      <p>
        Try fewer or different words, or <Link href="/add">add the files</Link> that should be here.
      </p>
    </div>
  );
}

/** Near misses, shown only when asked for and labelled as what they are (KF-SAS-RQ-217). */
function NearMisses({ nearMisses }: { readonly nearMisses: SearchResponse['nearMisses'] }) {
  return (
    <section aria-labelledby="search-near-miss-heading" data-list="near-misses">
      <h2 id="search-near-miss-heading" className="kf-results-heading">
        Near misses{' '}
        <small data-label={nearMisses?.label ?? 'near_miss'}>
          ({nearMisses?.label ?? 'near_miss'})
        </small>
      </h2>
      {nearMisses === undefined ? (
        <p role="status" className="kf-muted">
          You asked for near misses; there are none without matching by meaning.
        </p>
      ) : (
        <>
          <p className="kf-muted">
            Close to what you asked, but not part of the answer: the records ranked just below the
            related list.
          </p>
          <details className="kf-explainer">
            <summary>How these were chosen</summary>
            <p className="kf-ranking-name">
              Scoring function: <code>{nearMisses.scoringFunction}</code>
            </p>
          </details>
          {nearMisses.hits.length === 0 ? (
            <p role="status" className="kf-muted">
              No near misses.
            </p>
          ) : (
            <div className="kf-hits">
              {nearMisses.hits.map((hit) => (
                <HitCard key={hit.objectId} hit={hit} detail={`Near miss · rank ${hit.rank}`} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Every record that holds the words, with its ranking's name and how many there are. */
function LexicalList({
  lexical,
  limit,
  primary = false,
}: {
  readonly lexical: SearchResponse['lexical'];
  readonly limit: number;
  /** The list read first (the switch is off), rather than one folded under the fused list. */
  readonly primary?: boolean;
}) {
  return (
    <section
      aria-labelledby="search-lexical-heading"
      data-list="lexical"
      data-total={lexical.total}
    >
      {primary ? (
        <h2 id="search-lexical-heading" className="kf-results-heading">
          {lexical.total === 0
            ? 'Results'
            : `${lexical.total} result${lexical.total === 1 ? '' : 's'} with your exact words`}
        </h2>
      ) : (
        <h3 id="search-lexical-heading" className="kf-results-subheading">
          Word matches
        </h3>
      )}
      {primary ? null : <RankingName ranking={lexical.ranking} />}
      {primary ? null : (
        <p className="kf-muted">
          Every record you can see that holds at least half of what your words say, weighted so that
          rare words count more; the ones holding every word, and the phrase as typed, come first.
        </p>
      )}
      {lexical.hits.length === 0 ? (
        primary ? (
          <NoResults />
        ) : (
          <p role="status" className="kf-muted">
            No word matches among the records you can see.
          </p>
        )
      ) : (
        <div className="kf-hits">
          <p role="status" className="kf-muted">
            {lexical.complete
              ? `All ${lexical.total} word match${lexical.total === 1 ? '' : 'es'}.`
              : `Showing ${lexical.hits.length} of ${lexical.total} word matches (limit ${limit}).`}
          </p>
          {lexical.hits.map((hit) => (
            <HitCard
              key={hit.objectId}
              hit={hit}
              detail={hit.matchedBy === 'full_text' ? 'Word match' : 'Partial-identifier match'}
            />
          ))}
        </div>
      )}
      {primary ? (
        <details className="kf-explainer" data-explainer="ranking">
          <summary>How this was ranked</summary>
          <p>
            Search by meaning is off, so these are only the records that contain your words. Turn it
            on to also find records that say the same thing in other words.
          </p>
          <RankingName ranking={lexical.ranking} />
        </details>
      ) : null}
    </section>
  );
}

export function SearchResults({
  response,
  nearMissesRequested,
  limit,
  meaning = true,
}: {
  readonly response: SearchResponse;
  readonly nearMissesRequested: boolean;
  readonly limit: number;
  /** The "Search by meaning" switch; on unless the person turned it off. */
  readonly meaning?: boolean;
}) {
  const { ranked, lexical, semantic, nearMisses } = response;
  const engineNotes = response.withheld.filter(
    (entry) => entry.reasonClass === 'semantic_ranking_unavailable',
  );
  if (!meaning) {
    return (
      <div className="kf-results" data-meaning="off">
        <SearchNotices response={response} meaning={false} />
        <LexicalList lexical={lexical} limit={limit} primary />
        {nearMissesRequested ? <NearMisses nearMisses={nearMisses} /> : null}
      </div>
    );
  }
  return (
    <div className="kf-results" data-meaning="on">
      <SearchNotices response={response} />

      <section aria-labelledby="search-ranked-heading" data-list="ranked">
        <h2 id="search-ranked-heading" className="kf-results-heading">
          {ranked.hits.length === 0
            ? 'Results'
            : `${ranked.hits.length} result${ranked.hits.length === 1 ? '' : 's'}`}
        </h2>
        {ranked.hits.length === 0 ? (
          <NoResults />
        ) : (
          <div className="kf-hits">
            {ranked.hits.map((hit) => (
              <HitCard key={hit.objectId} hit={hit} />
            ))}
          </div>
        )}
        <details className="kf-explainer" data-explainer="ranking">
          <summary>How this was ranked</summary>
          <p>
            Records that contain your words and records related by meaning are combined into one
            list. Each result below says where each method placed it.
          </p>
          <RankingName ranking={ranked.ranking} />
          {engineNotes.map((note) => (
            <p key={note.reason} className="kf-muted" data-withholding={note.reasonClass}>
              Semantic ranking unavailable: {note.reason}. These results are word matches only.
            </p>
          ))}
          {ranked.hits.length === 0 ? null : (
            <ol className="kf-places">
              {ranked.hits.map((hit) => (
                <li key={hit.objectId}>
                  {hit.title}: {placesSentence(hit)}
                </li>
              ))}
            </ol>
          )}
        </details>
      </section>

      <details className="kf-explainer">
        <summary>Every record that matches your words ({lexical.total})</summary>
        <LexicalList lexical={lexical} limit={limit} />
      </details>

      <details className="kf-explainer">
        <summary>
          Records related by meaning{semantic === undefined ? '' : ` (${semantic.hits.length})`}
        </summary>
        <section aria-labelledby="search-semantic-heading" data-list="semantic">
          <h3 id="search-semantic-heading" className="kf-results-subheading">
            Related by meaning
          </h3>
          {semantic === undefined ? (
            engineNotes.length === 0 ? (
              <p role="status" className="kf-muted">
                No records related by meaning for these words.
              </p>
            ) : (
              engineNotes.map((note) => (
                <p
                  key={note.reason}
                  role="status"
                  className="kf-status kf-status-warning"
                  data-withholding={note.reasonClass}
                >
                  Semantic ranking unavailable: {note.reason}. The word matches are still complete.
                </p>
              ))
            )
          ) : (
            <>
              <RankingName ranking={semantic.ranking} />
              <p className="kf-muted">
                Ranked by the retrieval engine and re-checked against your access. Not exhaustive: a
                record missing here may still be a word match.
              </p>
              {semantic.hits.length === 0 ? (
                <p role="status" className="kf-muted">
                  No related records.
                </p>
              ) : (
                <div className="kf-hits">
                  {semantic.hits.map((hit) => (
                    <HitCard key={hit.objectId} hit={hit} detail={`Rank ${hit.rank}`} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </details>

      {nearMissesRequested ? <NearMisses nearMisses={nearMisses} /> : null}
    </div>
  );
}

/** Home's short form: the notices, the first results, and the way to all of them. */
export function SearchPreview({
  response,
  query,
  shown = 6,
  meaning = true,
}: {
  readonly response: SearchResponse;
  readonly query: string;
  readonly shown?: number;
  readonly meaning?: boolean;
}) {
  const list = shownList(response, meaning);
  const hits: readonly AnyHit[] = list.hits.slice(0, shown);
  const all = searchPageHref(query, meaning);
  const count = list.kind === 'lexical' ? list.total : list.hits.length;
  return (
    <section
      className="kf-results"
      data-list="preview"
      data-meaning={meaning ? 'on' : 'off'}
      aria-labelledby="home-results-heading"
    >
      <h2 id="home-results-heading" className="kf-results-heading">
        {meaning ? 'Records that match' : 'Records with your exact words'}
      </h2>
      <SearchNotices response={response} meaning={meaning} />
      {hits.length === 0 ? (
        <NoResults />
      ) : (
        <div className="kf-hits">
          {hits.map((hit) => (
            <HitCard key={hit.objectId} hit={hit} />
          ))}
        </div>
      )}
      {count > 0 ? (
        <p>
          <Link href={all} className="kf-link-strong">
            {count > hits.length ? `See all ${count} results` : 'Open in Search'}
          </Link>
        </p>
      ) : null}
    </section>
  );
}
