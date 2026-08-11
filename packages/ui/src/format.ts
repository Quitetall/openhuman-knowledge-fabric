/**
 * Presentation formatting.
 *
 * Pure functions, no React, so they can be tested without a renderer — and so the rules that
 * matter here are testable at all. Two of them are load-bearing:
 *
 * A missing number is never rendered as zero. "No work packages yet" and "none of the work is
 * done" are different facts, and showing 0% for the first is a lie that reads as progress
 * information.
 *
 * Money is formatted from integer minor units with its currency, never from a float and never
 * without the code. An amount shown without its currency is not an amount, and a reader who
 * assumes the wrong one is not making a reading error — they were given an ambiguous figure.
 */

/** A progress fraction as a percentage, or the reason there isn't one. */
export function formatProgress(progress: {
  totalPackages: number;
  disposedPackages: number;
  fraction: number | null;
}): string {
  if (progress.fraction === null) return 'no work packages yet';
  const percent = Math.round(progress.fraction * 100);
  return `${percent}% — ${progress.disposedPackages} of ${progress.totalPackages} packages accepted or waived`;
}

/**
 * Money, from integer minor units.
 *
 * Refuses a non-integer rather than rounding one: a value that arrived here as 1000.5 minor
 * units did not come from this system, and displaying a plausible number for it would hide
 * that.
 */
export function formatMoney(minor: number | string, currency: string): string {
  const value = typeof minor === 'string' ? Number(minor) : minor;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`amount must be an integer number of minor units, got ${String(minor)}`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RangeError(`currency must be a three-letter ISO 4217 code, got ${currency}`);
  }
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const major = Math.floor(abs / 100);
  const minorPart = String(abs % 100).padStart(2, '0');
  return `${sign}${major.toLocaleString('en-GB')}.${minorPart} ${currency}`;
}

/** A lifecycle state as a human-facing label, without inventing meaning it does not carry. */
export function formatState(state: string): string {
  return state.replaceAll('_', ' ');
}

/**
 * How a state should read at a glance.
 *
 * `terminal` is deliberately not `bad`: a rejected decision and a closed project are both
 * final, and colouring finality as failure would misreport half of them.
 */
export type StateTone = 'draft' | 'active' | 'awaiting' | 'terminal';

const AWAITING = new Set([
  'submitted',
  'under_review',
  'offered',
  'proposed',
  'evaluating',
  'triage',
  'impact_assessment',
  'authorized',
  'approved',
  'initiated',
  'planned',
  'ready',
]);

const TERMINAL = new Set([
  'administratively_closed',
  'rejected',
  'cancelled',
  'closed',
  'terminated',
  'accepted',
  'partially_accepted',
  'waived',
  'superseded',
  'withdrawn',
  'paid',
  'void',
  'reconciled',
  'reversed',
  'failed',
  'settled',
  'effective',
]);

export function stateTone(state: string): StateTone {
  if (state === 'draft' || state === 'captured') return 'draft';
  if (TERMINAL.has(state)) return 'terminal';
  if (AWAITING.has(state)) return 'awaiting';
  return 'active';
}

/**
 * Shorten a digest for display, keeping enough to be useful.
 *
 * Twelve characters is enough for a human to compare two by eye and far too few to verify
 * anything, which is the honest position: the full digest is what verifies, and this is a
 * label for it.
 */
export function shortDigest(digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) return digest;
  return `${digest.slice(0, 12)}…`;
}

/** An ISO timestamp as a fixed, unambiguous string. Never "3 hours ago" on a controlled record. */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // UTC, explicitly labelled. A local-time rendering of an audit event is ambiguous the
  // moment it is quoted anywhere else.
  return `${date.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}
