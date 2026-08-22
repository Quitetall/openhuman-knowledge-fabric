/**
 * The citation you type: `OH-DOC-000001-3 R01 §3-4, 6, 9`.
 *
 * This is the surface someone assembling an onboarding pack actually touches, so it accepts what
 * a person writes — `§`, `section`, `sections`, an en dash for a range, spaces wherever they
 * fall — and refuses anything ambiguous rather than guessing.
 *
 * THE REVISION IS PART OF THE CITATION, and omitting it is allowed but recorded as omitted.
 * Section numbers are positional: `§3` means different text after a revision, so a citation
 * without one is a claim about "whatever it says now". That is sometimes what you want and
 * never what you want in a pack someone will read next month, so the caller can tell the
 * difference and decide.
 */

export interface SectionSelector {
  /** `3` selects §3 and everything beneath it. */
  readonly from: string;
  /** Equal to `from` for a single section; the closing bound for `3-4`. Inclusive. */
  readonly to: string;
  /** Exactly as written, for error messages that quote the user back to themselves. */
  readonly source: string;
}

export interface Citation {
  /** `OH-DOC-000001-3`. Not validated against a registry here — that is the caller's authority. */
  readonly document: string;
  /** `R01`, or null when the citation did not pin one. */
  readonly revision: string | null;
  readonly sections: readonly SectionSelector[];
}

export class CitationSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CitationSyntaxError';
  }
}

/** `OH-DOC-000001-3` or `OH-RCD-2026-000001-5`, followed optionally by `R01`. */
const HEAD = /^\s*([A-Z]+-[A-Z]+-[0-9-]+)(?:\s+(R[0-9]{2,}))?\s*/;
/** `§`, `sec`, `section`, `sections`, `s.` — everything people actually type. */
const MARKER = /^(?:§+|sections?\b|secs?\.?\b|s\.)\s*/i;
/** `3`, `3.2`, `B.1`, and ranges with hyphen, en dash or em dash. */
const SELECTOR = /^((?:\d+|[A-Z])(?:\.\d+)*)\s*(?:[-–—]\s*((?:\d+|[A-Z])(?:\.\d+)*))?\s*$/;

export function parseCitation(text: string): Citation {
  const head = HEAD.exec(text);
  if (head?.[1] === undefined) {
    throw new CitationSyntaxError(
      `no document identifier at the start of ${JSON.stringify(text)}. ` +
        'Expected something like "OH-DOC-000001-3 R01 §3-4".',
    );
  }
  const rest = text.slice(head[0].length);
  const marker = MARKER.exec(rest);
  if (marker === null) {
    throw new CitationSyntaxError(
      `${head[1]} is cited with no sections. Write "§3", "§3-4" or "§3, 6, 9" — a citation ` +
        'naming a whole document should reference the document instead.',
    );
  }

  const body = rest.slice(marker[0].length).trim();
  if (body === '')
    throw new CitationSyntaxError(`${head[1]} has a section marker but no sections after it.`);

  const sections = body.split(',').map((piece): SectionSelector => {
    const source = piece.trim();
    const m = SELECTOR.exec(source);
    if (m?.[1] === undefined) {
      throw new CitationSyntaxError(
        `${JSON.stringify(source)} is not a section or a range of sections. ` +
          'Use "3", "3.2", "3-4" or "B.1".',
      );
    }
    // A reversed range is a typo, not an empty selection. Silently returning nothing here is
    // exactly how a pack ends up missing a section nobody notices is absent.
    const to = m[2] ?? m[1];
    return { from: m[1], to, source };
  });

  return { document: head[1], revision: head[2] ?? null, sections };
}
