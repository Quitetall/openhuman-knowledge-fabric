import { describe, expect, it } from 'vitest';
import { formatInstant, formatMoney, formatProgress, shortDigest, stateTone } from './format.js';

describe('progress', () => {
  it('says there are no packages rather than showing 0%', () => {
    // The lie this prevents: a project that has not been broken down yet reading as "0%
    // done", which is progress information about work nobody has scoped.
    expect(formatProgress({ totalPackages: 0, disposedPackages: 0, fraction: null })).toBe(
      'no work packages yet',
    );
  });

  it('shows 0% only when there is work and none of it is done', () => {
    expect(formatProgress({ totalPackages: 4, disposedPackages: 0, fraction: 0 })).toBe(
      '0% — 0 of 4 packages accepted or waived',
    );
  });

  it('reports the counts alongside the percentage', () => {
    expect(formatProgress({ totalPackages: 3, disposedPackages: 2, fraction: 2 / 3 })).toBe(
      '67% — 2 of 3 packages accepted or waived',
    );
  });
});

describe('money', () => {
  it('formats minor units with the currency', () => {
    expect(formatMoney(360000, 'GBP')).toBe('3,600.00 GBP');
    expect(formatMoney('4050', 'EUR')).toBe('40.50 EUR');
    expect(formatMoney(7, 'USD')).toBe('0.07 USD');
  });

  it('keeps the sign', () => {
    expect(formatMoney(-2550, 'GBP')).toBe('-25.50 GBP');
  });

  it('refuses a fractional minor unit rather than rounding it', () => {
    // A value that arrived as 1000.5 minor units did not come from this system, and showing
    // a plausible number for it would hide that.
    expect(() => formatMoney(1000.5, 'GBP')).toThrow(RangeError);
  });

  it('refuses an amount with no valid currency', () => {
    // An amount without its currency is not an amount.
    expect(() => formatMoney(1000, 'gbp')).toThrow(RangeError);
    expect(() => formatMoney(1000, '')).toThrow(RangeError);
  });
});

describe('state tone', () => {
  it('treats a rejected decision and a closed project alike — both final, neither a failure', () => {
    expect(stateTone('rejected')).toBe('terminal');
    expect(stateTone('administratively_closed')).toBe('terminal');
    expect(stateTone('accepted')).toBe('terminal');
  });

  it('marks states that are waiting on somebody', () => {
    expect(stateTone('under_review')).toBe('awaiting');
    expect(stateTone('submitted')).toBe('awaiting');
  });

  it('falls back to active for anything unrecognised, never to terminal', () => {
    // A new state that read as terminal would show open work as finished.
    expect(stateTone('some_future_state')).toBe('active');
  });
});

describe('digests and instants', () => {
  it('shortens a digest but passes anything else through untouched', () => {
    expect(shortDigest('a'.repeat(64))).toBe('aaaaaaaaaaaa…');
    expect(shortDigest('not-a-digest')).toBe('not-a-digest');
  });

  it('renders instants in UTC without discarding millisecond evidence', () => {
    // A local-time rendering of an audit event is ambiguous the moment it is quoted anywhere
    // else. Milliseconds stay visible because two governed events can share one second.
    expect(formatInstant('2026-08-11T09:30:00.123Z')).toBe('2026-08-11 09:30:00.123Z');
    expect(formatInstant('2026-08-11T09:30:00.000Z')).toBe('2026-08-11 09:30:00.000Z');
  });

  it('passes through anything that is not a timestamp', () => {
    expect(formatInstant('never')).toBe('never');
  });
});
