/**
 * Assemble many citations into one briefing that can GROW.
 *
 * The use this was built for: a new engineer needs §3-4, 6 and 9 of the registry, §4-5 of a QMS
 * procedure, and nothing else. Later they are given more access, and the same document has to
 * gain material without disturbing what they have already read.
 *
 * GROWTH MUST BE ADDITIVE, and that is a real constraint rather than a nicety. Someone who read
 * §3 last week and finds it silently different this week has no way to know, and stops trusting
 * the pack — at which point they go and read the whole source document, which is exactly the
 * context overload the briefing exists to prevent. So:
 *
 *   - entries keep the order they were added, not the order of their identifiers;
 *   - adding a citation never reorders or rewrites an existing entry;
 *   - each entry carries its own digest, so a diff of two briefings says WHICH parts moved
 *     rather than only that something did.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not decide who may see what. Classification and
 * access live on the objects and on `content.document_publication_target`, which already carries
 * a `max_classification` ceiling. A briefing that assembled material the recipient is not cleared
 * for, and looked tidy doing it, would be worse than no briefing — so this returns the material
 * and its provenance, and the caller applies the ceiling before anything is published.
 */

import { createHash } from 'node:crypto';
import type { DocumentAtom } from '../internal/parse-contract.js';
import { parseCitation, type Citation } from './parse.js';
import { resolveCitation, type ResolvedExcerpt } from './resolve.js';

export interface BriefingSource {
  /** As typed: `OH-DOC-000001-3 R01 §3-4, 6, 9`. */
  readonly citation: string;
  /** The parsed atoms of that document, in order. */
  readonly atoms: readonly DocumentAtom[];
  /** Optional human title for the entry heading; the identifier is used when absent. */
  readonly title?: string;
}

export interface BriefingEntry {
  readonly citation: Citation;
  readonly title: string;
  readonly excerpt: ResolvedExcerpt;
}

export interface Briefing {
  readonly entries: readonly BriefingEntry[];
  /** SHA-256 over each entry's digest in order. Changes if any cited text or the order changes. */
  readonly digest: string;
  /** Every unresolved selector, prefixed by its document, across all entries. */
  readonly unresolved: readonly string[];
  /** False when any selector matched nothing. Do not publish an incomplete briefing. */
  readonly isComplete: boolean;
}

export function assembleBriefing(sources: readonly BriefingSource[]): Briefing {
  const entries = sources.map((source): BriefingEntry => {
    const citation = parseCitation(source.citation);
    const excerpt = resolveCitation(source.atoms, citation);
    return { citation, title: source.title ?? citation.document, excerpt };
  });

  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${entry.excerpt.digest}\n`);

  const unresolved = entries.flatMap((e) =>
    e.excerpt.unresolved.map((s) => `${e.citation.document} §${s}`),
  );

  return {
    entries,
    digest: hash.digest('hex'),
    unresolved,
    isComplete: unresolved.length === 0,
  };
}

/**
 * Extend a briefing with more material, preserving everything already in it.
 *
 * Re-derived from the original sources rather than mutated, because a briefing is a value: two
 * callers holding the same one must not see it change underneath them. The returned briefing is
 * a superset in content and a prefix in order.
 */
export function growBriefing(
  previous: readonly BriefingSource[],
  additional: readonly BriefingSource[],
): Briefing {
  return assembleBriefing([...previous, ...additional]);
}

/**
 * Render a briefing as Markdown.
 *
 * EVERY ENTRY STATES ITS SOURCE AND ITS DIGEST. A briefing is an extract, and an extract that
 * does not say where it came from invites the reader to treat it as the authority — which it is
 * not, and which is how a stale copy outlives the document it was taken from. The header is the
 * thing that sends someone back to the source when it matters.
 */
export function renderBriefing(
  briefing: Briefing,
  options?: { readonly heading?: string },
): string {
  const lines: string[] = [`# ${options?.heading ?? 'Briefing'}`, ''];

  if (!briefing.isComplete) {
    // Loud, and at the top. An incomplete briefing that looks complete is the failure this
    // whole module is arranged to prevent.
    lines.push('> **INCOMPLETE — these citations matched nothing and are missing below:**');
    for (const item of briefing.unresolved) lines.push(`> - ${item}`);
    lines.push('');
  }

  lines.push(
    `Assembled from ${briefing.entries.length} source(s). Briefing digest \`${briefing.digest.slice(0, 16)}\`.`,
  );
  lines.push('');
  lines.push('Extracts, not authorities. Each entry names the document and revision it came from;');
  lines.push('read the source when the difference matters.');
  lines.push('');

  for (const entry of briefing.entries) {
    const rev = entry.citation.revision ?? 'revision not pinned';
    const cited = entry.excerpt.spans.map((s) => `§${s.path}`).join(', ');
    lines.push('---', '');
    lines.push(`## ${entry.title}`, '');
    lines.push(`\`${entry.citation.document}\` · ${rev} · ${cited || 'nothing matched'}`);
    lines.push(`Extract digest \`${entry.excerpt.digest.slice(0, 16)}\`.`);
    lines.push('');

    for (const atom of entry.excerpt.atoms) {
      if (atom.kind === 'heading' && atom.level !== null) {
        // Demoted by two so a document's top-level heading sits under the entry heading rather
        // than competing with the briefing title.
        lines.push(`${'#'.repeat(Math.min(6, atom.level + 2))} ${atom.text}`, '');
      } else if (atom.kind === 'code') {
        lines.push('```', atom.text, '```', '');
      } else if (atom.kind === 'list_item') {
        lines.push(`- ${atom.text}`);
      } else {
        lines.push(atom.text, '');
      }
    }
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
