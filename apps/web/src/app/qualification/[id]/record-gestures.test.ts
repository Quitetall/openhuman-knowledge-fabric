import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseRecordGestures, type RecordGestures } from '../../../lib/api/qualification';
import { RecordGesturesView } from './record-gestures';

/**
 * A record's institutional gestures are offered exactly as the API answers for this reader
 * (§100.62): a gesture the API did not offer is absent — not disabled, not explained away — and an
 * answer off contract offers nothing. Nothing here reads a role.
 *
 * Falsified: rendering the withdraw form whatever `gestures.withdraw` says fails "offers nothing
 * the API did not", and reading `available` as truthy rather than `=== true` fails the parse case.
 */

const RECORD = '01900000-0000-7000-8000-0000000000b1';
const NEWER = '01900000-0000-7000-8000-0000000000b2';
const noop = async () => {};

function render(gestures: RecordGestures): string {
  return renderToStaticMarkup(
    createElement(RecordGesturesView, {
      gestures,
      gestureId: 'gesture-0001',
      withdrawAction: noop,
      supersedeAction: noop,
    }),
  );
}

const answer = (withdraw: unknown, supersede: unknown, candidates: unknown[] = []) => ({
  format: 'kf-qualification-record-gestures-v1',
  recordId: RECORD,
  state: 'assigned',
  withdraw: { available: withdraw },
  supersede: { available: supersede, candidates },
});

const candidate = {
  recordId: NEWER,
  pack: { title: 'Aero engineer', revision: 2 },
  state: 'assigned',
  assignedAt: '2026-10-10T09:00:00.000Z',
};

describe('the gestures on a qualification record', () => {
  it('offers nothing the API did not', () => {
    expect(render(parseRecordGestures(answer(false, false)))).toBe('');
    const withdrawOnly = render(parseRecordGestures(answer(true, false, [candidate])));
    expect(withdrawOnly).toContain('data-gesture="withdraw"');
    expect(withdrawOnly).not.toContain('data-gesture="supersede"');
    expect(withdrawOnly).not.toContain(NEWER);
    expect(withdrawOnly).not.toContain('disabled');
  });

  it('offers a supersession only with a newer record to choose', () => {
    expect(render(parseRecordGestures(answer(false, true, [])))).toBe('');
    const html = render(parseRecordGestures(answer(false, true, [candidate])));
    expect(html).toContain('data-gesture="supersede"');
    expect(html).toContain(`value="${NEWER}"`);
    expect(html).not.toContain('data-gesture="withdraw"');
    // Each act asks for the reason it records.
    expect(html.match(/<input[^>]*name="reason"[^>]*>/)?.[0]).toMatch(/required/);
  });

  it('reads only `true` as an offer, and refuses an answer off contract', () => {
    const loose = parseRecordGestures(answer('yes', 1, [candidate]));
    expect(loose.withdraw).toBe(false);
    expect(loose.supersede).toBe(false);
    expect(loose.candidates).toEqual([]);
    expect(() => parseRecordGestures({ ...answer(true, true), format: 'other' })).toThrow();
    expect(() => parseRecordGestures(answer(true, true, [{ recordId: NEWER }]))).toThrow();
  });
});
