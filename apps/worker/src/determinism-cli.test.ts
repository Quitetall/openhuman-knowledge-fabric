import { describe, expect, it } from 'vitest';
import { determinismLimit } from './determinism-cli.js';

describe('kf-compiler-determinism takes a bounded sample size', () => {
  it('defaults to five and accepts 1 to 100', () => {
    expect(determinismLimit([])).toBe(5);
    expect(determinismLimit(['--limit', '1'])).toBe(1);
    expect(determinismLimit(['--limit', '100'])).toBe(100);
  });

  it('refuses anything else rather than guessing', () => {
    for (const argv of [
      ['--limit'],
      ['--limit', '0'],
      ['--limit', '101'],
      ['--limit', '-3'],
      ['5'],
    ]) {
      expect(() => determinismLimit(argv), argv.join(' ')).toThrow(/usage/);
    }
  });
});
