import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  canonicalBytes,
  chainDigest,
  digest,
  digestBytes,
  CanonicalizationError,
  GENESIS_DIGEST,
} from './index.js';

describe('RFC 8785 conformance', () => {
  it('matches the worked example from the RFC', () => {
    // RFC 8785 §3.2.4. Number formatting is the part implementations get wrong.
    // The string is the RFC's: € $ U+000F LF A ' B " backslash backslash " /
    const tricky = '€$\u000f\nA\'B"\\\\"/';
    const input = {
      // Losing precision IS the behaviour under test: the RFC requires this literal to
      // serialize as its nearest double, 333333333.3333333.
      // eslint-disable-next-line no-loss-of-precision
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: tricky,
      literals: [null, true, false],
    };
    const out = canonicalize(input);

    expect(out).toContain('"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]');
    expect(out).toContain('"literals":[null,true,false]');
    // Keys sort before values are considered: literals < numbers < string.
    expect(out.indexOf('"literals"')).toBeLessThan(out.indexOf('"numbers"'));
    expect(out.indexOf('"numbers"')).toBeLessThan(out.indexOf('"string"'));

    // Escaping is asserted by round trip plus the two forms the RFC pins down: a control
    // character with no short form uses lowercase \u00xx, and LF uses \n.
    expect(JSON.parse(out).string).toBe(tricky);
    expect(out).toContain('\\u000f');
    expect(out).not.toContain('\\u000F');
    expect(out).toContain('\\n');
    expect(out).toContain('€'); // non-ASCII stays literal, never escaped
  });

  it('sorts object keys by UTF-16 code unit, not by locale', () => {
    // Locale-aware collation would order these differently; JCS requires code-unit order.
    expect(canonicalize({ b: 1, a: 2, A: 3, ä: 4, Z: 5 })).toBe('{"A":3,"Z":5,"a":2,"b":1,"ä":4}');
  });

  it('sorts nested objects independently', () => {
    expect(canonicalize({ z: { d: 1, c: 2 }, a: { b: 3 } })).toBe(
      '{"a":{"b":3},"z":{"c":2,"d":1}}',
    );
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ a: [1, 2], b: {} })).toBe('{"a":[1,2],"b":{}}');
  });

  it('preserves array order, which is significant', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('renders negative zero as 0', () => {
    expect(canonicalize(-0)).toBe('0');
  });

  it('uses the shortest escape sequences', () => {
    expect(canonicalize('a\nb\tc"d\\e')).toBe('"a\\nb\\tc\\"d\\\\e"');
  });

  it('does not escape the solidus', () => {
    expect(canonicalize('a/b')).toBe('"a/b"');
  });
});

describe('values that must be rejected rather than coerced', () => {
  it.each([NaN, Infinity, -Infinity])('rejects %p', (n) => {
    expect(() => canonicalize(n)).toThrow(CanonicalizationError);
  });

  it('rejects undefined inside an array instead of writing null', () => {
    // JSON.stringify([undefined]) === "[null]" — that would hash a different value than
    // the caller supplied, which is exactly the silent corruption this guards against.
    expect(JSON.stringify([undefined])).toBe('[null]');
    expect(() => canonicalize([undefined])).toThrow(/undefined array element/);
  });

  it('rejects bigint rather than coercing it', () => {
    expect(() => canonicalize({ n: 1n })).toThrow(/bigint/);
  });

  it('reports the path of the offending value', () => {
    expect(() => canonicalize({ a: { b: [1, NaN] } })).toThrow(/a\.b\[1\]/);
  });

  it('drops undefined object properties, matching absence', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('digests', () => {
  it('is stable across key insertion order', () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });

  it('produces a 64-character lowercase hex string', () => {
    expect(digest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches a known SHA-256 of the canonical bytes', () => {
    // sha256 of the two bytes `{}`
    expect(canonicalBytes({}).toString('utf8')).toBe('{}');
    expect(digest({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('hashes raw artifact bytes without canonicalizing them', () => {
    // sha256 of the empty byte string
    expect(digestBytes(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('audit hash chain', () => {
  it('commits to its predecessor', () => {
    const a = chainDigest(GENESIS_DIGEST, { event: 1 });
    const b = chainDigest(a, { event: 2 });
    const c = chainDigest(b, { event: 3 });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('breaks every subsequent digest when history is altered', () => {
    const honest1 = chainDigest(GENESIS_DIGEST, { event: 1, amount: '100.00' });
    const honest2 = chainDigest(honest1, { event: 2 });

    const tampered1 = chainDigest(GENESIS_DIGEST, { event: 1, amount: '900.00' });
    const tampered2 = chainDigest(tampered1, { event: 2 });

    expect(tampered1).not.toBe(honest1);
    // The point of the chain: event 2 was not touched, yet its digest no longer matches.
    expect(tampered2).not.toBe(honest2);
  });

  it('rejects a malformed previous digest', () => {
    expect(() => chainDigest('not-a-digest', {})).toThrow(CanonicalizationError);
    expect(() => chainDigest('abc', {})).toThrow(CanonicalizationError); // too short
    expect(() => chainDigest('0'.repeat(65), {})).toThrow(CanonicalizationError); // too long
    // Uppercase hex is rejected so a digest has exactly one spelling. Accepting both would
    // let the same chain state be written two ways and then compare unequal.
    expect(() => chainDigest('A'.repeat(64), {})).toThrow(CanonicalizationError);
    expect(() => chainDigest(GENESIS_DIGEST, {})).not.toThrow();
  });
});
