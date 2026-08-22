/**
 * Turn a citation into exact atoms, and refuse to be vague about what it could not find.
 *
 * This is the piece that makes "give the new engineer §3-4, 6 and 9 and nothing else" a real
 * operation rather than a copy-paste. Two properties matter more than convenience:
 *
 * A SELECTOR THAT MATCHES NOTHING IS AN ERROR, NOT AN OMISSION. If someone cites §9 of a
 * document with eight sections, the pack must not quietly contain eight. Silent omission is the
 * failure mode that makes an assembled document untrustworthy — the reader cannot tell the
 * difference between "there was nothing to say" and "the citation was wrong". `unresolved` is
 * returned rather than thrown so a caller can report every bad selector at once instead of the
 * first, but it is never empty-and-ignored: `isComplete` exists so the check is hard to skip.
 *
 * THE EXCERPT CARRIES A DIGEST OF WHAT IT ACTUALLY TOOK. Every atom already has an `atom_digest`
 * from the parse. Hashing the selected ones in order gives a value that changes when the cited
 * TEXT changes, which is strictly more than pinning a revision tells you: re-resolve later and
 * you learn whether the material a person was given still says what it said. A copy-pasted
 * excerpt in a shared drive can never answer that.
 */

import { createHash } from 'node:crypto';
import type { DocumentAtom } from '../internal/parse-contract.js';
import type { Citation, SectionSelector } from './parse.js';
import {
  compareSectionPaths,
  indexSections,
  isWithinSection,
  type SectionSpan,
} from './sections.js';

export interface ResolvedExcerpt {
  readonly citation: Citation;
  /** Matched spans, in document order, deduplicated. */
  readonly spans: readonly SectionSpan[];
  /** The atoms themselves, in document order, each appearing once. */
  readonly atoms: readonly DocumentAtom[];
  /** SHA-256 over the selected atom digests in order. Changes when the cited text changes. */
  readonly digest: string;
  /** Selectors that matched no section, as written. Empty when everything resolved. */
  readonly unresolved: readonly string[];
  /** False when any selector matched nothing. Check this before publishing an excerpt. */
  readonly isComplete: boolean;
}

/** Does this span fall inside the selector's closed range? */
function selects(span: SectionSpan, selector: SectionSelector): boolean {
  // `3-4` means 3, its subsections, 4, and ITS subsections — the closing bound includes its own
  // subtree. Comparing paths alone would stop at 4 and drop 4.1, which reads as a truncated
  // section rather than a missing one and is therefore worse.
  const atOrAfterStart =
    compareSectionPaths(span.path, selector.from) >= 0 || isWithinSection(span.path, selector.from);
  const atOrBeforeEnd =
    compareSectionPaths(span.path, selector.to) <= 0 || isWithinSection(span.path, selector.to);
  return atOrAfterStart && atOrBeforeEnd;
}

export function resolveCitation(
  atoms: readonly DocumentAtom[],
  citation: Citation,
): ResolvedExcerpt {
  const index = indexSections(atoms);

  // Keyed by firstOrdinal, which is unique per heading. Keying by PATH silently dropped a span
  // whenever two shared one — which a real document produced within minutes of this being run
  // against it. A dedup key that is not unique is a data-loss bug wearing a correctness hat.
  const matched = new Map<number, SectionSpan>();
  const unresolved: string[] = [];
  for (const selector of citation.sections) {
    const hits = index.filter((span) => selects(span, selector));
    if (hits.length === 0) {
      unresolved.push(selector.source);
      continue;
    }
    // Overlapping selectors (`3-4, 3`) must not duplicate the section. Keyed by path so the
    // same span selected twice appears once.
    for (const span of hits) matched.set(span.firstOrdinal, span);
  }

  const spans = [...matched.values()].sort((a, b) => a.firstOrdinal - b.firstOrdinal);

  // Collected by ordinal so nested spans (§3 and §3.1 both matched) contribute their atoms once
  // and only once, still in document order.
  const wanted = new Set<number>();
  for (const span of spans) {
    for (let o = span.firstOrdinal; o <= span.lastOrdinal; o += 1) wanted.add(o);
  }
  const selected = atoms.filter((a) => wanted.has(a.ordinal)).sort((a, b) => a.ordinal - b.ordinal);

  const hash = createHash('sha256');
  for (const atom of selected) hash.update(`${atom.ordinal}:${atom.digest}\n`);

  return {
    citation,
    spans,
    atoms: selected,
    digest: hash.digest('hex'),
    unresolved,
    isComplete: unresolved.length === 0,
  };
}
