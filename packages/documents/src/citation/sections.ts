/**
 * Where the sections of a parsed document are.
 *
 * `content.document_atom` stores an ordered stream with a `heading_level`, which is enough to
 * render a document and not enough to cite one. Nothing in it says "§3". This module computes
 * that, so a citation like `OH-DOC-000001-3 R01 §3-4` can be resolved to exact atoms.
 *
 * COMPUTED ON READ, NOT STORED. A `section_path` column would need every existing parse
 * re-run to backfill, and would then be a second copy of something derivable from the atom
 * stream — the kind of duplication that drifts. Sections are cheap to recompute and there is
 * exactly one definition of them, here.
 *
 * TWO SOURCES OF A SECTION NUMBER, AND THEY DISAGREE.
 *
 *   declared   the number the author wrote: `## 3 Core information model`
 *   nested     the number implied by heading depth and order
 *
 * They agree in a tidy document and diverge in a real controlled one, which restarts numbering
 * for appendices (`Appendix B`, then `B.1`), skips numbers, or carries an unnumbered preface.
 * A citation resolved by the wrong rule points at the wrong text and says nothing about it,
 * which for an onboarding pack means handing someone confidently-labelled wrong material.
 *
 * So: prefer the DECLARED number, because it is what a human means by "§3", and fall back to
 * nesting only where the author wrote none. Every span records which rule produced it, so a
 * caller can tell the difference and a reviewer can see it.
 */

import type { DocumentAtom } from '../internal/parse-contract.js';

export interface SectionSpan {
  /** `3`, `3.2`, `B.1`. The address a citation uses. */
  readonly path: string;
  /** True when the author wrote the number; false when it was derived from nesting. */
  readonly declared: boolean;
  /** Heading depth, 1-based, as the parser reported it. */
  readonly level: number;
  /** Heading text with any leading number removed — `Core information model`. */
  readonly title: string;
  /** Ordinal of the heading atom itself. */
  readonly firstOrdinal: number;
  /**
   * Ordinal of the last atom belonging to this section, INCLUDING its subsections. A section
   * runs until the next heading at the same or shallower level, so §3 contains §3.1 and its
   * body — which is what someone asking for "section 3" means.
   */
  readonly lastOrdinal: number;
}

/**
 * A leading section number, if the author wrote one.
 *
 * Accepts `3`, `3.2`, `3.2.1`, `B`, `B.1` — digits or a single capital for appendices. A
 * separator is REQUIRED, so `3.2.1` alone (a version string) and `1.` (a list marker) are not
 * mistaken for a numbered heading with no title.
 *
 * `\s` covers the non-breaking space a word processor emits between a number and its title, so
 * it does not need spelling out — an earlier version wrote a literal U+00A0 into the class,
 * which was both redundant and an invisible character in source that eslint rightly refused.
 */
const DECLARED = /^\s*((?:\d+|[A-Z])(?:\.\d+)*)\s+(\S.*)$/;

/** Compare two section paths in document order: 3 < 3.1 < 3.10 < 4 < B < B.1. */
export function compareSectionPaths(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    // Numeric where both are numbers, so 10 sorts after 9 rather than before it. A letter
    // (appendix) sorts after every number, which is where appendices live.
    if (Number.isInteger(nx) && Number.isInteger(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (Number.isInteger(nx)) {
      return -1;
    } else if (Number.isInteger(ny)) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** True when `path` is `ancestor` or lives beneath it: (3, 3.2) yes, (3, 30) no. */
export function isWithinSection(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

/**
 * Index the sections of a parsed document.
 *
 * Atoms are taken in the order given. Non-heading atoms before the first heading belong to no
 * section and are simply not indexed — a document preamble is not citable as "§0", and
 * inventing a section for it would let a citation silently pick up a title block.
 */
export function indexSections(atoms: readonly DocumentAtom[]): readonly SectionSpan[] {
  const headings = atoms.filter((a) => a.kind === 'heading' && a.level !== null);

  // DOES THIS DOCUMENT NUMBER ITS SECTIONS AT ALL? Found by running this against the real
  // OH-DOC-000002-1 parse, where it produced two spans both called §1: an unnumbered "Contents"
  // heading took `1` from the nesting counter, and the actual "1 Scope and authority" declared
  // `1` right after it. Citing §1 then resolved to whichever won a Map write.
  //
  // In a document that numbers anything, an UNNUMBERED heading is front or back matter —
  // contents, a title block, a colophon — not section n. It still gets indexed, so nothing is
  // lost, but under a path that cannot be confused with a declared one and cannot shadow it.
  const anyDeclared = headings.some((a) => DECLARED.test(a.text));
  const spans: SectionSpan[] = [];
  /** Counter per depth, for headings the author left unnumbered. */
  const counters: number[] = [];

  for (const atom of headings) {
    const level = atom.level as number;
    const match = DECLARED.exec(atom.text);

    let path: string;
    let title: string;
    if (match?.[1] !== undefined && match[2] !== undefined) {
      path = match[1];
      title = match[2].trim();
      // Keep the nesting counters aligned with what the author declared, so an unnumbered
      // heading AFTER a numbered one continues the sequence instead of restarting at 1.
      const parts = path.split('.');
      counters.length = parts.length;
      const last = Number(parts[parts.length - 1]);
      counters[parts.length - 1] = Number.isInteger(last) ? last : 0;
    } else if (anyDeclared) {
      // Unnumbered, in a numbered document: front/back matter. `@ordinal` is unique, sorts
      // after every numeric and lettered path, and is obviously not something a person meant
      // to type — so it can be listed and rendered but never silently answers a `§1`.
      path = `@${atom.ordinal}`;
      title = atom.text.trim();
    } else {
      counters.length = level;
      counters[level - 1] = (counters[level - 1] ?? 0) + 1;
      path = counters
        .slice(0, level)
        .map((n) => n ?? 0)
        .join('.');
      title = atom.text.trim();
    }

    spans.push({
      path,
      declared: match !== null,
      level,
      title,
      firstOrdinal: atom.ordinal,
      // Provisional: closed below, once the next heading at this depth or shallower is known.
      lastOrdinal: atom.ordinal,
    });
  }

  // Close each span at the atom before the next heading of the same or shallower level. Done as
  // a second pass because a section's extent is not knowable until its successor is seen.
  const lastOrdinal = atoms.length > 0 ? Math.max(...atoms.map((a) => a.ordinal)) : 0;
  return spans.map((span, i) => {
    const next = spans.slice(i + 1).find((s) => s.level <= span.level);
    return { ...span, lastOrdinal: next === undefined ? lastOrdinal : next.firstOrdinal - 1 };
  });
}
