import Link from 'next/link';
import { formatState } from '@kf/ui';
import type { RankedSearchHit, SearchHit, SearchResponse, SemanticSearchHit } from '../../lib/api';
import { Badge } from '../components/badge';
import { VerificationNote } from '../components/verification-note';
import { recordHref } from './search-view';

/**
 * The composed search answer (KF-SAS-RQ-224, RQ-216, RQ-217, ADR 0037).
 *
 * One list first: the word matches and the records related by meaning, fused, under the name of
 * the fusion. Each result says which ranking placed it and where — "words #3 · meaning #1" — so a
 * merely similar record never reads as a match on the words. The two source lists follow, folded,
 * each under its own ranking's name: the word matches are the complete answer within the caller's
 * scope, with their count, and the meaning list is the engine's own order. Near misses appear only
 * when asked for, labelled as what they are. What the caller could be granted but is not is one
 * count, never a title; when the engine could not rank, the page says so at the top rather than
 * showing the word matches as if they were the whole answer.
 */

/** ADR 0037's disclosure, in words: a count within the caller's ceiling, and nothing else. */
export function withheldCountSentence(count: number): string | undefined {
  if (count === 0) return undefined;
  const records = count === 1 ? '1 more matching record' : `${count} more matching records`;
  return (
    `${records} ${count === 1 ? 'is' : 'are'} within your clearance but not granted to you, so ` +
    `${count === 1 ? 'it is' : 'they are'} not shown. Ask for access to see ${count === 1 ? 'it' : 'them'}. ` +
    'Nothing above your clearance is counted.'
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

function HitCard({ hit, detail }: { readonly hit: AnyHit; readonly detail: string }) {
  const href = recordHref(hit.objectType, hit.objectId);
  return (
    <article
      data-object-type={hit.objectType}
      data-object-id={hit.objectId}
      style={{ border: '1px solid #cbd5e1', borderRadius: '0.65rem', padding: '1rem' }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <h4 style={{ fontSize: '1rem', margin: 0 }}>
          <Link href={href} style={{ color: '#0f766e' }}>
            {hit.title}
          </Link>
        </h4>
        <Badge state={hit.lifecycleState} />
      </div>
      <p style={{ color: '#475569', margin: '0.45rem 0 0', fontSize: '0.85rem' }}>
        {formatState(hit.objectType)} · {formatState(hit.classification)} · {detail}
      </p>
      <VerificationNote verification={hit.verification} />
      <code style={{ color: '#64748b', fontSize: '0.78rem' }}>{hit.objectId}</code>
    </article>
  );
}

function RankingName({ ranking }: { readonly ranking: string }) {
  return (
    <p style={{ color: '#64748b', margin: '0.15rem 0 0.6rem', fontSize: '0.8rem' }}>
      Ranking: <code data-ranking={ranking}>{ranking}</code>
    </p>
  );
}

export function SearchResults({
  response,
  nearMissesRequested,
  limit,
}: {
  readonly response: SearchResponse;
  readonly nearMissesRequested: boolean;
  readonly limit: number;
}) {
  const { ranked, lexical, semantic, nearMisses, withheld } = response;
  const withheldSentence = withheldCountSentence(response.withheldCount);
  const engineNotes = withheld.filter(
    (entry) => entry.reasonClass === 'semantic_ranking_unavailable',
  );
  return (
    <div style={{ display: 'grid', gap: '1.75rem' }}>
      {withheldSentence === undefined ? null : (
        <p
          role="status"
          className="kf-status kf-status-neutral"
          data-withheld-count={response.withheldCount}
        >
          {withheldSentence}
        </p>
      )}

      <section aria-labelledby="search-ranked-heading" data-list="ranked">
        <h3 id="search-ranked-heading" style={{ fontSize: '1.05rem', margin: 0 }}>
          Results
        </h3>
        <RankingName ranking={ranked.ranking} />
        {engineNotes.map((note) => (
          <p
            key={note.reason}
            role="status"
            className="kf-status kf-status-warning"
            data-withholding={note.reasonClass}
          >
            Semantic ranking unavailable: {note.reason}. These results are word matches only.
          </p>
        ))}
        {ranked.hits.length === 0 ? (
          <p role="status" className="kf-status kf-status-neutral">
            Nothing found in your current access context.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {ranked.hits.map((hit) => (
              <HitCard key={hit.objectId} hit={hit} detail={placesSentence(hit)} />
            ))}
          </div>
        )}
      </section>

      <details>
        <summary style={{ cursor: 'pointer', color: '#334155' }}>
          All word matches ({lexical.total})
        </summary>
        <section
          aria-labelledby="search-lexical-heading"
          data-list="lexical"
          data-total={lexical.total}
          style={{ marginTop: '0.75rem' }}
        >
          <h3 id="search-lexical-heading" style={{ fontSize: '1.05rem', margin: 0 }}>
            Word matches
          </h3>
          <RankingName ranking={lexical.ranking} />
          <p style={{ color: '#475569', margin: '0 0 0.6rem', fontSize: '0.85rem' }}>
            Every record in your scope that holds at least half of what your words say, weighted so
            that rare words count more; the ones holding every word, and the phrase as typed, come
            first.
          </p>
          {lexical.hits.length === 0 ? (
            <p role="status" className="kf-status kf-status-neutral">
              No word matches in your current access context.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <p role="status" aria-live="polite" style={{ color: '#475569', margin: 0 }}>
                {lexical.complete
                  ? `All ${lexical.total} word match${lexical.total === 1 ? '' : 'es'}.`
                  : `Showing ${lexical.hits.length} of ${lexical.total} word matches (request limit ${limit}).`}
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
        </section>
      </details>

      <details>
        <summary style={{ cursor: 'pointer', color: '#334155' }}>
          Related by meaning, in the engine&apos;s order
          {semantic === undefined ? '' : ` (${semantic.hits.length})`}
        </summary>
        <section
          aria-labelledby="search-semantic-heading"
          data-list="semantic"
          style={{ marginTop: '0.75rem' }}
        >
          <h3 id="search-semantic-heading" style={{ fontSize: '1.05rem', margin: 0 }}>
            Related by meaning
          </h3>
          {semantic === undefined ? (
            engineNotes.length === 0 ? (
              <p role="status" className="kf-status kf-status-neutral">
                No semantic ranking for this query.
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
              <p style={{ color: '#475569', margin: '0 0 0.6rem', fontSize: '0.85rem' }}>
                Ranked by the retrieval engine and re-checked against your access. Not exhaustive: a
                record missing here may still be a word match.
              </p>
              {semantic.hits.length === 0 ? (
                <p role="status" className="kf-status kf-status-neutral">
                  No related records.
                </p>
              ) : (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  {semantic.hits.map((hit) => (
                    <HitCard key={hit.objectId} hit={hit} detail={`Rank ${hit.rank}`} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </details>

      {nearMissesRequested ? (
        <section aria-labelledby="search-near-miss-heading" data-list="near-misses">
          <h3 id="search-near-miss-heading" style={{ fontSize: '1.05rem', margin: 0 }}>
            Near misses{' '}
            <small data-label={nearMisses?.label ?? 'near_miss'}>
              ({nearMisses?.label ?? 'near_miss'})
            </small>
          </h3>
          {nearMisses === undefined ? (
            <p role="status" className="kf-status kf-status-neutral">
              You asked for near misses; there are none without a semantic ranking.
            </p>
          ) : (
            <>
              <p style={{ color: '#64748b', margin: '0.15rem 0 0.6rem', fontSize: '0.8rem' }}>
                Scoring function: <code>{nearMisses.scoringFunction}</code>
              </p>
              <p style={{ color: '#475569', margin: '0 0 0.6rem', fontSize: '0.85rem' }}>
                Adjacent to the answer, not part of it: the records ranked just below the related
                list, offered because you asked.
              </p>
              {nearMisses.hits.length === 0 ? (
                <p role="status" className="kf-status kf-status-neutral">
                  No near misses.
                </p>
              ) : (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  {nearMisses.hits.map((hit) => (
                    <HitCard key={hit.objectId} hit={hit} detail={`Near miss · rank ${hit.rank}`} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
