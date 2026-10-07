import type { Verification } from '../../lib/api/verification';

/**
 * The three states a reader is told about a record, shown by FORM and not by colour alone
 * (SAS §24B, "It reads as a document"): a glyph, a word and a border style each differ, so the
 * chip reads the same in greyscale, in high contrast and to a screen reader.
 *
 *   verified    solid border, a check     the label names who and on what basis (title)
 *   unverified  dashed border, an open ring
 *   withheld    dotted border, a hollow square; carries a count, never a title (ADR 0037)
 */
export function VerificationChip({ verification }: { readonly verification: Verification }) {
  return verification.verified ? (
    <span className="kf-chip kf-chip-verified" title={verification.label} data-state="verified">
      <span aria-hidden="true" className="kf-chip-glyph">
        ✓
      </span>
      verified
    </span>
  ) : (
    <span className="kf-chip kf-chip-unverified" title={verification.label} data-state="unverified">
      <span aria-hidden="true" className="kf-chip-glyph">
        ○
      </span>
      unverified
    </span>
  );
}

export function WithheldChip({ count }: { readonly count: number }) {
  return (
    <span className="kf-chip kf-chip-withheld" data-state="withheld">
      <span aria-hidden="true" className="kf-chip-glyph">
        □
      </span>
      {count} withheld
    </span>
  );
}
