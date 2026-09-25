import { describe, expect, it } from 'vitest';
import { ActionRejected } from '@kf/actions';
import { parseRequestedNextAction } from './submission-contract.js';

describe('generated OpenWarrant submission boundary', () => {
  it.each(['continue', 'verify', 'block', 'amend', 'cancel'])('accepts %s', (value) => {
    expect(parseRequestedNextAction(value)).toBe(value);
  });
  it('preserves existing whitespace normalization', () => {
    expect(parseRequestedNextAction(' verify ')).toBe('verify');
  });
  it.each([undefined, null, 1, {}, [], '', 'ship', 'toString', '__proto__'])(
    'refuses invalid input %j',
    (value) => {
      expect(() => parseRequestedNextAction(value)).toThrow(ActionRejected);
    },
  );
});
