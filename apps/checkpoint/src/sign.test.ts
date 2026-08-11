import { describe, expect, it } from 'vitest';
import { chainDigest, GENESIS_DIGEST } from '@kf/canonicalization';
import { leafHash } from './merkle.js';
import {
  buildCheckpoint,
  checkInclusion,
  generateSigningKey,
  leafBytes,
  proveInclusion,
  verifyChain,
  verifyCheckpoint,
  type AuditEntry,
} from './sign.js';

/** A chain of `n` events, linked exactly the way the dispatcher links them. */
function chain(n: number, mutate?: (e: AuditEntry, i: number) => AuditEntry): AuditEntry[] {
  const out: AuditEntry[] = [];
  let prev = GENESIS_DIGEST;
  for (let i = 0; i < n; i++) {
    const body = {
      action_id: `0193aaaa-0000-7000-8000-${String(i).padStart(12, '0')}`,
      action_type: 'accept_decision',
      actor_id: '0193bbbb-0000-7000-8000-000000000001',
      effective_at: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    };
    const d = chainDigest(prev, body);
    let entry: AuditEntry = {
      seq: i + 1,
      id: `0193cccc-0000-7000-8000-${String(i).padStart(12, '0')}`,
      action_id: body.action_id,
      actor_id: body.actor_id,
      action_type: body.action_type,
      recorded_at: body.effective_at,
      prev_digest: prev,
      digest: d,
    };
    if (mutate) entry = mutate(entry, i);
    out.push(entry);
    prev = d;
  }
  return out;
}

const key = generateSigningKey('test-key-1');

describe('chain verification', () => {
  it('accepts an intact chain', () => {
    expect(verifyChain(chain(5), GENESIS_DIGEST)).toEqual({ ok: true });
  });

  it('reports the exact event where the chain breaks', () => {
    const events = chain(5);
    const broken = events.map((e, i) => (i === 3 ? { ...e, prev_digest: 'f'.repeat(64) } : e));
    const result = verifyChain(broken, GENESIS_DIGEST);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.atSeq).toBe(4);
  });

  it('catches a deleted event, which leaves a gap in the links', () => {
    const events = chain(5);
    const withHole = [...events.slice(0, 2), ...events.slice(3)];
    expect(verifyChain(withHole, GENESIS_DIGEST).ok).toBe(false);
  });
});

describe('checkpoint signing', () => {
  it('signs a range and verifies', () => {
    const cp = buildCheckpoint(chain(8), key, GENESIS_DIGEST);
    expect(cp.fromSeq).toBe(1);
    expect(cp.toSeq).toBe(8);
    expect(cp.leafCount).toBe(8);
    expect(cp.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyCheckpoint(cp, key.publicKey)).toBe(true);
  });

  it('fails verification under a different key', () => {
    const cp = buildCheckpoint(chain(4), key, GENESIS_DIGEST);
    expect(verifyCheckpoint(cp, generateSigningKey('other').publicKey)).toBe(false);
  });

  it('fails verification if the root is altered', () => {
    const cp = buildCheckpoint(chain(4), key, GENESIS_DIGEST);
    expect(verifyCheckpoint({ ...cp, merkleRoot: 'a'.repeat(64) }, key.publicKey)).toBe(false);
  });

  it('fails verification if the RANGE is altered, not only the root', () => {
    // The signature covers what was attested to, not just its hash. Otherwise a checkpoint
    // could be replayed as covering a different span of history.
    const cp = buildCheckpoint(chain(4), key, GENESIS_DIGEST);
    expect(verifyCheckpoint({ ...cp, toSeq: 99 }, key.publicKey)).toBe(false);
    expect(verifyCheckpoint({ ...cp, leafCount: 99 }, key.publicKey)).toBe(false);
  });

  it('refuses to sign an empty range', () => {
    expect(() => buildCheckpoint([], key, GENESIS_DIGEST)).toThrow(/nothing to attest/);
  });

  it('refuses to sign a chain that is already broken', () => {
    // Signing here would attest TO tampering rather than against it.
    const events = chain(5).map((e, i) => (i === 2 ? { ...e, digest: 'e'.repeat(64) } : e));
    expect(() => buildCheckpoint(events, key, GENESIS_DIGEST)).toThrow(/already broken at seq 4/);
  });

  it('changes the root when any event changes', () => {
    const a = buildCheckpoint(chain(6), key, GENESIS_DIGEST);
    const tampered = chain(6).map((e, i) => (i === 2 ? { ...e, actor_id: 'someone-else' } : e));
    // The chain still links (digests unchanged), but the leaf content differs — which is
    // exactly the attack a chain alone misses and a Merkle commitment catches.
    const b = buildCheckpoint(tampered, key, GENESIS_DIGEST);
    expect(b.merkleRoot).not.toBe(a.merkleRoot);
  });

  it('changes the root when two events are reordered', () => {
    // Leaves bind seq, so swapping positions changes the tree even though the same events
    // are present.
    const events = chain(6);
    const swapped = [...events];
    swapped[2] = { ...events[3]!, seq: events[2]!.seq };
    swapped[3] = { ...events[2]!, seq: events[3]!.seq };
    const a = buildCheckpoint(events, key, GENESIS_DIGEST);
    expect(
      Buffer.compare(leafBytes(swapped[2]!), leafBytes(events[2]!)),
      'the swapped leaf must differ',
    ).not.toBe(0);
    // Chain verification catches this first, which is the correct order of defences.
    expect(() => buildCheckpoint(swapped, key, GENESIS_DIGEST)).toThrow(/already broken/);
    expect(a.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('inclusion proofs', () => {
  it('proves a specific event was in the signed history', () => {
    // What an auditor actually asks: show me THIS approval was in what you signed — without
    // handing over the whole log.
    const events = chain(16);
    const cp = buildCheckpoint(events, key, GENESIS_DIGEST);
    for (const seq of [1, 5, 11, 16]) {
      const { proof, leaf } = proveInclusion(events, seq);
      expect(checkInclusion(leaf, proof, cp.merkleRoot), `seq ${seq}`).toBe(true);
    }
  });

  it('rejects a proof for an event that was not there', () => {
    const events = chain(16);
    const cp = buildCheckpoint(events, key, GENESIS_DIGEST);
    const { proof } = proveInclusion(events, 5);
    const forged = { ...events[4]!, actor_id: 'never-happened' };
    expect(checkInclusion(leafHash(leafBytes(forged)), proof, cp.merkleRoot)).toBe(false);
  });

  it('rejects a proof against a different checkpoint', () => {
    const a = chain(8);
    const cpB = buildCheckpoint(chain(9), key, GENESIS_DIGEST);
    const { proof, leaf } = proveInclusion(a, 3);
    expect(checkInclusion(leaf, proof, cpB.merkleRoot)).toBe(false);
  });

  it('refuses to prove a sequence outside the range', () => {
    expect(() => proveInclusion(chain(4), 99)).toThrow(RangeError);
  });
});
