import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SearchResponse } from '../../lib/api';
import { UNVERIFIED_LABEL } from '../../lib/api/verification.js';
import { SearchResults, withheldCountSentence } from './search-results.js';

const unverified = { verified: false, label: UNVERIFIED_LABEL } as const;
const LEXICAL = 'kf.lexical.full_text+partial_identifier.v1';
const SEMANTIC = 'lamu.embed.bge-m3.v1';

const exact = {
  objectId: 'exact-1',
  objectType: 'decision_record',
  title: 'Exact match record',
  lifecycleState: 'accepted',
  classification: 'internal',
  rank: 0.9,
  matchedBy: 'full_text' as const,
  verification: unverified,
};
const related = {
  objectId: 'related-1',
  objectType: 'decision_record',
  title: 'Related by meaning record',
  lifecycleState: 'accepted',
  classification: 'internal',
  rank: 1,
  score: 0.8,
  verification: unverified,
};
const adjacent = { ...related, objectId: 'near-1', title: 'Near miss record', rank: 51 };

function response(extra: Partial<SearchResponse> = {}): SearchResponse {
  return {
    lexical: { ranking: LEXICAL, total: 1, complete: true, hits: [exact] },
    withheld: [],
    withheldCount: 0,
    hits: [exact],
    ...extra,
  };
}

function render(value: SearchResponse, nearMissesRequested = false): string {
  return renderToStaticMarkup(
    createElement(SearchResults, { response: value, nearMissesRequested, limit: 50 }),
  );
}

/** The markup of one list, by its data-list attribute. */
function list(html: string, name: string): string {
  const start = html.indexOf(`data-list="${name}"`);
  if (start < 0) return '';
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

describe('the search page renders the composed answer, not just the hits', () => {
  it('shows the lexical and semantic lists apart, each with its ranking name', () => {
    const html = render(response({ semantic: { ranking: SEMANTIC, hits: [related] } }));
    const lexical = list(html, 'lexical');
    const semantic = list(html, 'semantic');
    expect(lexical).toContain(LEXICAL);
    expect(lexical).toContain('Exact match record');
    expect(lexical).not.toContain('Related by meaning record');
    expect(semantic).toContain(SEMANTIC);
    expect(semantic).toContain('Related by meaning record');
    expect(semantic).not.toContain('Exact match record');
  });

  it('shows near misses only when requested, labelled with their scoring function', () => {
    const nearMisses = {
      label: 'near_miss',
      scoringFunction: `kf.near-miss.rank-window.v1(${SEMANTIC}; ranks 51-100)`,
      hits: [adjacent],
    };
    const withThem = response({ semantic: { ranking: SEMANTIC, hits: [related] }, nearMisses });
    expect(list(render(withThem), 'near-misses')).toBe('');
    const shown = list(render(withThem, true), 'near-misses');
    expect(shown).toContain('Near misses');
    expect(shown).toContain('near_miss');
    expect(shown).toContain('kf.near-miss.rank-window.v1');
    expect(shown).toContain('Near miss record');
    expect(list(render(withThem, true), 'semantic')).not.toContain('Near miss record');
  });

  it('states the withheld count in ADR 0037 terms, and nothing when there is none', () => {
    const html = render(response({ withheldCount: 2 }));
    expect(html).toContain('data-withheld-count="2"');
    expect(html).toContain(
      '2 more matching records are within your clearance but not granted to you',
    );
    expect(html).toContain('Nothing above your clearance is counted.');
    expect(render(response())).not.toContain('data-withheld-count');
    expect(withheldCountSentence(1)).toMatch(/^1 more matching record is within your clearance/);
  });

  it('says the semantic ranking is unavailable, with the reason, when the engine could not rank', () => {
    const html = render(
      response({
        withheld: [
          {
            reasonClass: 'semantic_ranking_unavailable',
            reason: 'no retrieval engine is configured',
          },
        ],
      }),
    );
    const semantic = list(html, 'semantic');
    expect(semantic).toContain('Semantic ranking unavailable: no retrieval engine is configured');
    expect(semantic).toContain('data-withholding="semantic_ranking_unavailable"');
    expect(list(html, 'lexical')).toContain('Exact match record');
  });
});
