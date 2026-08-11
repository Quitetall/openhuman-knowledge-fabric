import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inclusionProof, leafHash, merkleRoot, nodeHash, verifyInclusion } from './merkle.js';

const leaves = (n: number): Buffer[] =>
  Array.from({ length: n }, (_, i) => leafHash(Buffer.from(`event-${i}`)));

describe('merkle root', () => {
  it('uses the RFC 6962 empty-tree root, not a zero digest', () => {
    // "no events" must be distinguishable from "digest not computed".
    expect(merkleRoot([]).toString('hex')).toBe(createHash('sha256').digest('hex'));
    expect(merkleRoot([]).toString('hex')).not.toBe('0'.repeat(64));
  });

  it('returns the single leaf for a one-element tree', () => {
    const l = leaves(1);
    expect(merkleRoot(l).equals(l[0]!)).toBe(true);
  });

  it('separates leaf and interior domains', () => {
    // Without the 0x00/0x01 prefixes an interior preimage could be replayed as a leaf.
    const data = Buffer.from('same-bytes');
    expect(leafHash(data).equals(createHash('sha256').update(data).digest())).toBe(false);
    expect(nodeHash(data, data).equals(leafHash(Buffer.concat([data, data])))).toBe(false);
  });

  it('changes when any leaf changes', () => {
    const a = leaves(5);
    const b = [...a];
    b[3] = leafHash(Buffer.from('tampered'));
    expect(merkleRoot(a).equals(merkleRoot(b))).toBe(false);
  });

  it('is order sensitive', () => {
    const a = leaves(4);
    const b = [a[1]!, a[0]!, a[2]!, a[3]!];
    expect(merkleRoot(a).equals(merkleRoot(b))).toBe(false);
  });

  it('does not duplicate a lone odd node (CVE-2012-2459 malleability)', () => {
    // Duplicating the odd node would make a 3-leaf tree collide with a 4-leaf tree whose
    // last leaf repeats the third. Promotion avoids that.
    const three = leaves(3);
    const forged = [...three, three[2]!];
    expect(merkleRoot(three).equals(merkleRoot(forged))).toBe(false);
  });
});

describe('inclusion proofs', () => {
  it.each([1, 2, 3, 4, 5, 7, 8, 16, 17])('verifies every leaf in a tree of %i', (n) => {
    const l = leaves(n);
    const root = merkleRoot(l);
    for (let i = 0; i < n; i++) {
      expect(verifyInclusion(l[i]!, inclusionProof(l, i), root)).toBe(true);
    }
  });

  it('rejects a proof for a leaf that is not in the tree', () => {
    const l = leaves(8);
    const root = merkleRoot(l);
    expect(
      verifyInclusion(leafHash(Buffer.from('never-recorded')), inclusionProof(l, 3), root),
    ).toBe(false);
  });

  it('rejects a proof against a different root', () => {
    const l = leaves(8);
    const other = merkleRoot(leaves(9));
    expect(verifyInclusion(l[0]!, inclusionProof(l, 0), other)).toBe(false);
  });

  it('rejects a tampered sibling', () => {
    const l = leaves(8);
    const root = merkleRoot(l);
    const proof = inclusionProof(l, 5);
    const tampered = {
      ...proof,
      path: proof.path.map((s, i) => (i === 0 ? { ...s, hash: leafHash(Buffer.from('x')) } : s)),
    };
    expect(verifyInclusion(l[5]!, tampered, root)).toBe(false);
  });

  it('rejects an out-of-range index', () => {
    expect(() => inclusionProof(leaves(4), 4)).toThrow(RangeError);
    expect(() => inclusionProof(leaves(4), -1)).toThrow(RangeError);
  });
});
