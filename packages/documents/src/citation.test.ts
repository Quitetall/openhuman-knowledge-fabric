/**
 * Section citation: addressing parts of documents, and assembling them into one briefing.
 *
 * The behaviours worth defending are not "it finds section 3". They are the ones that decide
 * whether someone can trust a pack assembled this way:
 *
 *   a selector that matches nothing is reported, never silently dropped
 *   a range includes the closing section's subsections, so §3-4 does not truncate §4
 *   growing a briefing does not disturb what is already in it
 *   the digest changes when the cited TEXT changes, not merely when the document does
 */

import { describe, expect, it } from 'vitest';
import type { DocumentAtom } from './internal/parse-contract.js';
import { compareSectionPaths, indexSections } from './citation/sections.js';
import { CitationSyntaxError, parseCitation } from './citation/parse.js';
import { resolveCitation } from './citation/resolve.js';
import { assembleBriefing, growBriefing, renderBriefing } from './citation/assemble.js';

let ordinal = 0;
function atom(kind: DocumentAtom['kind'], text: string, level: number | null = null): DocumentAtom {
  ordinal += 1;
  return {
    ordinal,
    kind,
    level,
    text,
    attributes: {},
    // Digest of the text, so a test that changes text changes the digest the way a real parse
    // would. A constant here would make the drift-detection test pass for the wrong reason.
    digest: `d-${Buffer.from(text).toString('base64url').slice(0, 12)}`,
  };
}

/** A document shaped like a real controlled one: preamble, numbered body, lettered appendix. */
function specimen(): readonly DocumentAtom[] {
  ordinal = 0;
  return [
    atom('paragraph', 'OpenHuman Technologies LLC'),
    atom('table', 'Document OH-DOC-000001-3 Revision R01'),
    atom('heading', '1 Scope and authority', 1),
    atom('paragraph', 'This document defines identity.'),
    atom('heading', '2 Design basis', 1),
    atom('paragraph', 'Decisions adopted.'),
    atom('heading', '3 Core information model', 1),
    atom('paragraph', 'Every object gets a UUIDv7.'),
    atom('heading', '3.1 Object identity', 2),
    atom('paragraph', 'Immutable and permanent.'),
    atom('heading', '4 Identity layers', 1),
    atom('paragraph', 'Enterprise grammar.'),
    atom('heading', '4.1 Namespaces', 2),
    atom('paragraph', 'Nineteen of them.'),
    atom('heading', '5 Semantic codes', 1),
    atom('paragraph', 'Product families.'),
    atom('heading', '6 Physical items', 1),
    atom('paragraph', 'Parts and assemblies.'),
    atom('heading', 'Appendix A Damm table', 1),
    atom('paragraph', 'The quasigroup.'),
    atom('heading', 'B.1 Regex conformance', 2),
    atom('paragraph', 'Necessary but not sufficient.'),
  ];
}

describe('indexSections', () => {
  it('prefers the number the author declared over the one nesting implies', () => {
    const spans = indexSections(specimen());
    const byPath = new Map(spans.map((s) => [s.path, s]));
    expect([...byPath.keys()]).toContain('3.1');
    expect(byPath.get('3')?.title).toBe('Core information model');
    expect(byPath.get('3')?.declared).toBe(true);
  });

  it('runs a section to the end of its subsections, not to its next sibling heading', () => {
    // §3 must contain §3.1 and §3.1's body. Someone asking for "section 3" who receives only the
    // paragraph before §3.1 has been given a truncated section and no indication of it.
    const atoms = specimen();
    const three = indexSections(atoms).find((s) => s.path === '3');
    const covered = atoms.filter(
      (a) => a.ordinal >= (three?.firstOrdinal ?? 0) && a.ordinal <= (three?.lastOrdinal ?? 0),
    );
    expect(covered.map((a) => a.text)).toContain('Immutable and permanent.');
    expect(covered.map((a) => a.text)).not.toContain('Enterprise grammar.');
  });

  it('does not invent a section for the preamble', () => {
    // Atoms before the first heading belong to no section. Inventing "§0" would let a citation
    // silently pick up a title block and its control table.
    const spans = indexSections(specimen());
    expect(spans.every((s) => s.firstOrdinal >= 3)).toBe(true);
  });

  it('does not let an unnumbered heading claim a number a real section uses', () => {
    // FOUND BY RUNNING THIS AGAINST THE REAL OH-DOC-000002-1 PARSE, not by thinking about it.
    // Its unnumbered "Contents" heading took `1` from the nesting counter, and "1 Scope and
    // authority" declared `1` immediately after — two spans, one path. resolveCitation deduped
    // by path, so `§1` silently returned whichever won the Map write and dropped the other.
    ordinal = 0;
    const spans = indexSections([
      atom('heading', 'Contents', 1),
      atom('paragraph', 'front matter'),
      atom('heading', '1 Scope and authority', 1),
      atom('paragraph', 'the real section one'),
    ]);
    expect(new Set(spans.map((s) => s.path)).size).toBe(spans.length);
    expect(spans.find((s) => s.path === '1')?.title).toBe('Scope and authority');
    // Front matter is still indexed — nothing is lost, it just cannot be cited as §1.
    expect(spans.find((s) => s.title === 'Contents')?.declared).toBe(false);
  });

  it('still numbers by nesting when the document declares nothing at all', () => {
    // The fallback must survive: a document with no numbers anywhere is still citable.
    ordinal = 0;
    const spans = indexSections([atom('heading', 'Alpha', 1), atom('heading', 'Beta', 1)]);
    expect(spans.map((s) => s.path)).toEqual(['1', '2']);
  });

  it('falls back to nesting only where the author numbered nothing', () => {
    ordinal = 0;
    const spans = indexSections([
      atom('heading', 'Overview', 1),
      atom('paragraph', 'no numbers anywhere'),
      atom('heading', 'Details', 1),
    ]);
    expect(spans.map((s) => [s.path, s.declared])).toEqual([
      ['1', false],
      ['2', false],
    ]);
  });

  it('reads a heading separated by a non-breaking space, as a word processor emits', () => {
    // The claim that `\s` covers U+00A0, pinned. A .docx round-trip puts a non-breaking space
    // between a section number and its title, and a resolver that silently stopped recognising
    // those headings would fall back to nesting and renumber the whole document.
    ordinal = 0;
    const spans = indexSections([atom('heading', '7\u00a0Interface contracts', 1)]);
    expect(spans[0]).toMatchObject({ path: '7', title: 'Interface contracts', declared: true });
  });

  it('orders 10 after 9, and appendices after numbers', () => {
    expect(compareSectionPaths('9', '10')).toBeLessThan(0);
    expect(compareSectionPaths('3.2', '3.10')).toBeLessThan(0);
    expect(compareSectionPaths('B', '9')).toBeGreaterThan(0);
  });
});

describe('parseCitation', () => {
  it('reads document, revision and a mixed selector list', () => {
    const c = parseCitation('OH-DOC-000001-3 R01 §3-4, 6, 9');
    expect(c.document).toBe('OH-DOC-000001-3');
    expect(c.revision).toBe('R01');
    expect(c.sections.map((s) => [s.from, s.to])).toEqual([
      ['3', '4'],
      ['6', '6'],
      ['9', '9'],
    ]);
  });

  it.each([
    'OH-DOC-000001-3 sections 3-4',
    'OH-DOC-000001-3 section 3-4',
    'OH-DOC-000001-3 §§3-4',
    'OH-DOC-000001-3 §3–4', // en dash, which is what a word processor produces
  ])('accepts %s', (text) => {
    expect(parseCitation(text).sections[0]).toMatchObject({ from: '3', to: '4' });
  });

  it('records an unpinned revision as null rather than guessing one', () => {
    expect(parseCitation('OH-DOC-000001-3 §3').revision).toBeNull();
  });

  it.each([
    ['OH-DOC-000001-3', 'cited with no sections'],
    ['§3-4', 'no document identifier'],
    ['OH-DOC-000001-3 §', 'no sections after it'],
    ['OH-DOC-000001-3 §three', 'not a section'],
  ])('refuses %s', (text, message) => {
    expect(() => parseCitation(text)).toThrow(CitationSyntaxError);
    expect(() => parseCitation(text)).toThrow(new RegExp(message));
  });
});

describe('resolveCitation', () => {
  it('selects exactly the cited sections and nothing between them', () => {
    const atoms = specimen();
    const excerpt = resolveCitation(atoms, parseCitation('OH-DOC-000001-3 R01 §3, 6'));
    const text = excerpt.atoms.map((a) => a.text);
    expect(text).toContain('Every object gets a UUIDv7.');
    expect(text).toContain('Parts and assemblies.');
    expect(text).not.toContain('Enterprise grammar.'); // §4 was not asked for
    expect(excerpt.isComplete).toBe(true);
  });

  it('includes the closing section’s subsections in a range', () => {
    // §3-4 must carry §4.1. Stopping at §4's own body reads as a complete section that is
    // quietly missing half its content — worse than an obvious gap.
    //
    // Asserting only on atoms was NOT a test: §4's span already runs through its subsections, so
    // §4.1's atoms arrive whether or not the selector logic accounts for the subtree. Deleting
    // that logic left the atom assertion green. `spans` is what the subtree rule actually
    // governs, and it is what the rendered header shows the reader — a missing §4.1 there is a
    // briefing that under-reports its own contents.
    const excerpt = resolveCitation(specimen(), parseCitation('OH-DOC-000001-3 §3-4'));
    expect(excerpt.atoms.map((a) => a.text)).toContain('Nineteen of them.');
    expect(excerpt.spans.map((s) => s.path)).toEqual(['3', '3.1', '4', '4.1']);
  });

  it('REPORTS a selector that matched nothing instead of dropping it', () => {
    // The property the whole module exists for. A pack that silently contains less than it
    // claims cannot be trusted, and the reader has no way to detect it.
    const excerpt = resolveCitation(specimen(), parseCitation('OH-DOC-000001-3 §3, 99'));
    expect(excerpt.unresolved).toEqual(['99']);
    expect(excerpt.isComplete).toBe(false);
    expect(excerpt.atoms.length).toBeGreaterThan(0); // §3 still resolved
  });

  it('does not duplicate a section selected twice', () => {
    const excerpt = resolveCitation(specimen(), parseCitation('OH-DOC-000001-3 §3-4, 3, 3.1'));
    const ordinals = excerpt.atoms.map((a) => a.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it('changes its digest when the cited text changes, and not when other text does', () => {
    // Strictly more than pinning a revision: re-resolve later and you learn whether the material
    // someone was GIVEN still says what it said.
    const base = resolveCitation(specimen(), parseCitation('OH-DOC-000001-3 §3'));

    const editedElsewhere = specimen().map((a) =>
      a.text === 'Parts and assemblies.'
        ? { ...a, text: 'Parts, assemblies and tooling.', digest: 'd-changed' }
        : a,
    );
    expect(resolveCitation(editedElsewhere, parseCitation('OH-DOC-000001-3 §3')).digest).toBe(
      base.digest,
    );

    const editedInside = specimen().map((a) =>
      a.text === 'Every object gets a UUIDv7.'
        ? { ...a, text: 'Every object gets a UUIDv4.', digest: 'd-uuid4' }
        : a,
    );
    expect(resolveCitation(editedInside, parseCitation('OH-DOC-000001-3 §3')).digest).not.toBe(
      base.digest,
    );
  });
});

describe('assembling a briefing that grows', () => {
  // DELIBERATELY ADDED REVERSE-SORTED. The first version ran 000001 then 000002 — already in
  // lexicographic order — so sorting entries by identifier was a no-op and the order test passed
  // against an implementation that reordered them. A fixture satisfying both the right and the
  // wrong behaviour is not a fixture.
  const qms = { citation: 'OH-DOC-000002-1 R01 §5', atoms: specimen(), title: 'QMS Procedure' };
  const registry = {
    citation: 'OH-DOC-000001-3 R01 §3-4, 6',
    atoms: specimen(),
    title: 'Identifier Registry',
  };

  it('keeps entries in the order they were added, not sorted by identifier', () => {
    const b = assembleBriefing([qms, registry]);
    expect(b.entries.map((e) => e.title)).toEqual(['QMS Procedure', 'Identifier Registry']);
    expect(b.entries.map((e) => e.citation.document)).toEqual([
      'OH-DOC-000002-1',
      'OH-DOC-000001-3',
    ]);
  });

  it('GROWS without disturbing what was already there', () => {
    // Someone who read the first entry last week must find it unchanged this week, or they stop
    // trusting the pack and go read the whole source — the overload this exists to avoid.
    const before = assembleBriefing([registry]);
    const after = growBriefing([registry], [qms]);

    expect(after.entries[0]?.excerpt.digest).toBe(before.entries[0]?.excerpt.digest);
    expect(after.entries.slice(0, 1).map((e) => e.title)).toEqual(
      before.entries.map((e) => e.title),
    );
    expect(after.entries).toHaveLength(2);
    // The briefing digest DOES move, which is correct: the document as a whole changed.
    expect(after.digest).not.toBe(before.digest);
  });

  it('collects unresolved selectors from every entry, qualified by document', () => {
    const b = assembleBriefing([registry, { ...qms, citation: 'OH-DOC-000002-1 §77' }]);
    expect(b.isComplete).toBe(false);
    expect(b.unresolved).toEqual(['OH-DOC-000002-1 §77']);
  });

  it('renders an incomplete briefing with the failure at the top, not buried', () => {
    const rendered = renderBriefing(
      assembleBriefing([{ ...registry, citation: 'OH-DOC-000001-3 §99' }]),
    );
    expect(rendered).toMatch(/INCOMPLETE/);
    expect(rendered.indexOf('INCOMPLETE')).toBeLessThan(rendered.indexOf('Identifier Registry'));
  });

  it('names the source and revision on every entry', () => {
    // An extract that does not say where it came from invites being treated as the authority.
    const rendered = renderBriefing(assembleBriefing([registry]), { heading: 'Onboarding' });
    expect(rendered).toMatch(/# Onboarding/);
    expect(rendered).toMatch(/`OH-DOC-000001-3` · R01/);
    expect(rendered).toMatch(/Extracts, not authorities/);
  });

  it('says so when a revision was not pinned', () => {
    const rendered = renderBriefing(
      assembleBriefing([{ ...registry, citation: 'OH-DOC-000001-3 §3' }]),
    );
    expect(rendered).toMatch(/revision not pinned/);
  });
});
