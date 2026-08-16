import { describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { auditChainDigest, GENESIS_DIGEST } from '@kf/canonicalization';
import { leafHash } from './merkle.js';
import {
  auditSequence,
  buildCheckpoint,
  checkInclusion,
  generateSigningKey,
  leafBytes,
  loadSigningKey,
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
    const objectId = `0193dddd-0000-7000-8000-${String(i).padStart(12, '0')}`;
    const body = {
      action_id: `0193aaaa-0000-7000-8000-${String(i).padStart(12, '0')}`,
      action_type: 'accept_decision',
      actor_id: '0193bbbb-0000-7000-8000-000000000001',
      acting_role_id: '0193eeee-0000-7000-8000-000000000001',
      object_ids: [objectId],
      effective_at: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      before_digest: 'a'.repeat(64),
      after_digest: 'b'.repeat(64),
    };
    const d = auditChainDigest(prev, body);
    let entry: AuditEntry = {
      seq: String(i + 1),
      id: `0193cccc-0000-7000-8000-${String(i).padStart(12, '0')}`,
      action_id: body.action_id,
      actor_id: body.actor_id,
      acting_role_id: body.acting_role_id,
      action_type: body.action_type,
      object_id: objectId,
      object_ids: body.object_ids,
      recorded_at: body.effective_at,
      effective_at: body.effective_at,
      request_id: `request-${String(i)}`,
      reason: i % 2 === 0 ? 'test reason' : null,
      before_digest: body.before_digest,
      after_digest: body.after_digest,
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
const legacyVectorPublicKey = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
-----END PUBLIC KEY-----
`);

// Frozen before v3 existed, under a deterministic test-only Ed25519 key. These literals make
// legacy compatibility independent from buildCheckpoint: changing both producer and verifier
// cannot silently rewrite what v1/v2 historically signed.
const LEGACY_V1_LEAF =
  '{"action_id":"0193aaaa-0000-7000-8000-000000000000","action_type":"accept_decision","actor_id":"0193bbbb-0000-7000-8000-000000000001","digest":"37b7df9b8d35d2c7f91d31031a227481a323e42657e649971a5648b641991129","id":"0193cccc-0000-7000-8000-000000000000","prev_digest":"0000000000000000000000000000000000000000000000000000000000000000","recorded_at":"2026-08-01T00:00:00.000Z","seq":1}';
const LEGACY_V2_LEAF =
  '{"acting_role_id":"0193eeee-0000-7000-8000-000000000001","action_id":"0193aaaa-0000-7000-8000-000000000000","action_type":"accept_decision","actor_id":"0193bbbb-0000-7000-8000-000000000001","after_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","before_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","digest":"37b7df9b8d35d2c7f91d31031a227481a323e42657e649971a5648b641991129","effective_at":"2026-08-01T00:00:00.000Z","id":"0193cccc-0000-7000-8000-000000000000","object_id":"0193dddd-0000-7000-8000-000000000000","object_ids":["0193dddd-0000-7000-8000-000000000000"],"prev_digest":"0000000000000000000000000000000000000000000000000000000000000000","reason":"test reason","recorded_at":"2026-08-01T00:00:00.000Z","request_id":"request-0","seq":1}';

describe('chain verification', () => {
  it('accepts an intact chain', () => {
    expect(verifyChain(chain(5), GENESIS_DIGEST)).toEqual({ ok: true });
  });

  it('reports the exact event where the chain breaks', () => {
    const events = chain(5);
    const broken = events.map((e, i) => (i === 3 ? { ...e, prev_digest: 'f'.repeat(64) } : e));
    const result = verifyChain(broken, GENESIS_DIGEST);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.atSeq).toBe('4');
  });

  it('catches a deleted event, which leaves a gap in the links', () => {
    const events = chain(5);
    const withHole = [...events.slice(0, 2), ...events.slice(3)];
    expect(verifyChain(withHole, GENESIS_DIGEST).ok).toBe(false);
  });
});

describe('checkpoint signing', () => {
  it('refuses a non-Ed25519 private signing key before producing evidence', () => {
    const privatePem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    }) as string;

    expect(() => loadSigningKey('wrong-algorithm', privatePem)).toThrow(
      /not an Ed25519 private key/,
    );
  });

  it('refuses an Ed25519 private/public key mismatch', () => {
    const privateHalf = generateSigningKey('mismatched');
    const otherPublicHalf = generateSigningKey('other').publicKey;

    expect(() =>
      buildCheckpoint(chain(2), { ...privateHalf, publicKey: otherPublicHalf }, GENESIS_DIGEST),
    ).toThrow(/public key does not match/);
  });

  it('refuses signing-key ids that verification key loaders cannot represent', () => {
    expect(() => generateSigningKey('bad/id')).toThrow(/signing key id/);
  });

  it('signs a range and verifies', () => {
    const cp = buildCheckpoint(chain(8), key, GENESIS_DIGEST);
    expect(cp.formatVersion).toBe('kf.audit-checkpoint.v3');
    expect(cp.fromSeq).toBe('1');
    expect(cp.toSeq).toBe('8');
    expect(cp.leafCount).toBe('8');
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
    expect(verifyCheckpoint({ ...cp, toSeq: '99' }, key.publicKey)).toBe(false);
    expect(verifyCheckpoint({ ...cp, leafCount: '99' }, key.publicKey)).toBe(false);
  });

  it('refuses to sign an empty range', () => {
    expect(() => buildCheckpoint([], key, GENESIS_DIGEST)).toThrow(/nothing to attest/);
  });

  it('refuses to sign a chain that is already broken', () => {
    // Signing here would attest TO tampering rather than against it.
    const events = chain(5).map((e, i) => (i === 2 ? { ...e, digest: 'e'.repeat(64) } : e));
    expect(() => buildCheckpoint(events, key, GENESIS_DIGEST)).toThrow(/already broken at seq 3/);
  });

  it('changes the root when any event changes', () => {
    const a = buildCheckpoint(chain(6), key, GENESIS_DIGEST);
    const tampered = chain(6).map((e, i) =>
      i === 2 ? { ...e, reason: 'silently changed reason' } : e,
    );
    // `reason` was not part of the historical chain digest. v2 leaves still commit to it.
    const b = buildCheckpoint(tampered, key, GENESIS_DIGEST);
    expect(b.merkleRoot).not.toBe(a.merkleRoot);
  });

  it('rejects a linked row whose stored digest does not match its semantic fields', () => {
    const events = chain(3);
    const changed = events.map((entry, index) =>
      index === 1 ? { ...entry, acting_role_id: '0193eeee-0000-7000-8000-999999999999' } : entry,
    );
    const result = verifyChain(changed, GENESIS_DIGEST);
    expect(result).toMatchObject({ ok: false, atSeq: '2' });
    if (!result.ok) expect(result.detail).toMatch(/recomputed/);
  });

  it('refuses to emit new checkpoints under verification-only legacy formats', () => {
    const invoke = buildCheckpoint as unknown as (...args: unknown[]) => unknown;
    expect(() => invoke(chain(2), key, GENESIS_DIGEST, 'kf.audit-checkpoint.v2')).toThrow(
      /verification-only/,
    );
  });

  it('matches frozen v1/v2 leaves and signatures from before v3', () => {
    const entries = chain(2);
    expect(leafBytes(entries[0]!, 'kf.audit-checkpoint.v1').toString('utf8')).toBe(LEGACY_V1_LEAF);
    expect(leafBytes(entries[0]!, 'kf.audit-checkpoint.v2').toString('utf8')).toBe(LEGACY_V2_LEAF);

    expect(
      verifyCheckpoint(
        {
          formatVersion: 'kf.audit-checkpoint.v1',
          fromSeq: '1',
          toSeq: '2',
          leafCount: '2',
          merkleRoot: '59f26e62c3e80db9f698bd76b0b9f6a8850d5e5ea67ccf7b4a22790689b58408',
          signingKeyId: 'legacy-vector-key',
          signature:
            'Bv1Ijt6mo392EimQ1v4veCzWjN5eNHDMZt1C7bKDaiaUEDfnW5yIvSdHyfUSF+AhUK6D/HZXCWxYOVuTVd5oCg==',
        },
        legacyVectorPublicKey,
      ),
    ).toBe(true);

    for (const [formatVersion, merkleRoot] of [
      [
        'kf.audit-checkpoint.v1',
        '59f26e62c3e80db9f698bd76b0b9f6a8850d5e5ea67ccf7b4a22790689b58408',
      ],
      [
        'kf.audit-checkpoint.v2',
        '83edd09c8d4d83b2e801c5f5e8dded168b06d82d4d0fa2a57498603f4dd2d33c',
      ],
    ] as const) {
      const { proof, leaf } = proveInclusion(entries, '1', formatVersion);
      expect(checkInclusion(leaf, proof, merkleRoot)).toBe(true);
    }
    expect(
      verifyCheckpoint(
        {
          formatVersion: 'kf.audit-checkpoint.v2',
          fromSeq: '1',
          toSeq: '2',
          leafCount: '2',
          merkleRoot: '83edd09c8d4d83b2e801c5f5e8dded168b06d82d4d0fa2a57498603f4dd2d33c',
          signingKeyId: 'legacy-vector-key',
          signature:
            '83G5tlDvKAG/XBYo+2jx5ufkEBAZp2VcC4ev1cn/TCBfADoRj1He3f64ZFsX1KimyGCZOC0n8p7ZA1W7tfVHBQ==',
        },
        legacyVectorPublicKey,
      ),
    ).toBe(true);
  });

  it('signs sequence ranges above JavaScript safe integers without rounding', () => {
    const events = chain(2).map((entry, index) => ({
      ...entry,
      seq: (9_007_199_254_740_993n + BigInt(index)).toString(),
    }));

    const checkpoint = buildCheckpoint(events, key, GENESIS_DIGEST);

    expect(checkpoint.fromSeq).toBe('9007199254740993');
    expect(checkpoint.toSeq).toBe('9007199254740994');
    expect(checkpoint.formatVersion).toBe('kf.audit-checkpoint.v3');
    expect(leafBytes(events[0]!, checkpoint.formatVersion)).not.toEqual(
      leafBytes(events[1]!, checkpoint.formatVersion),
    );
    expect(verifyCheckpoint(checkpoint, key.publicKey)).toBe(true);
  });

  it('accepts exactly PostgreSQL positive bigint sequence domain', () => {
    expect(auditSequence('9223372036854775807')).toBe('9223372036854775807');
    expect(() => auditSequence('9223372036854775808')).toThrow(/PostgreSQL bigint/);
    expect(() => auditSequence('01')).toThrow(/PostgreSQL bigint/);
    expect(() => auditSequence(9_007_199_254_740_992)).toThrow(/safe integer/);
  });

  it('fails closed on legacy numeric checkpoints outside their exact historical domain', () => {
    const unsafe = { ...chain(1)[0]!, seq: '9007199254740992' };
    expect(() => leafBytes(unsafe, 'kf.audit-checkpoint.v2')).toThrow(/safe integer/);
  });

  it('rejects noncanonical base64 signatures before cryptographic verification', () => {
    const checkpoint = buildCheckpoint(chain(4), key, GENESIS_DIGEST);

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const trailingIndex = alphabet.indexOf(checkpoint.signature[85]!);
    const noncanonicalTrailingBits = `${checkpoint.signature.slice(0, 85)}${alphabet[trailingIndex + 1]}==`;
    expect(Buffer.from(noncanonicalTrailingBits, 'base64')).toEqual(
      Buffer.from(checkpoint.signature, 'base64'),
    );

    expect(
      verifyCheckpoint({ ...checkpoint, signature: `${checkpoint.signature}\n` }, key.publicKey),
    ).toBe(false);
    expect(
      verifyCheckpoint({ ...checkpoint, signature: noncanonicalTrailingBits }, key.publicKey),
    ).toBe(false);
  });

  it('refuses a checkpoint whose audit sequence positions are not strictly increasing', () => {
    const repeated = chain(3).map((entry, index) => (index === 2 ? { ...entry, seq: '2' } : entry));

    expect(() => buildCheckpoint(repeated, key, GENESIS_DIGEST)).toThrow(/strictly increasing/);
  });

  it('rejects unknown checkpoint format identifiers at verification', () => {
    const checkpoint = buildCheckpoint(chain(2), key, GENESIS_DIGEST);
    const unknown = { ...checkpoint, formatVersion: 'kf.audit-checkpoint.v999' };

    expect(verifyCheckpoint(unknown as never, key.publicKey)).toBe(false);
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
      Buffer.compare(
        leafBytes(swapped[2]!, a.formatVersion),
        leafBytes(events[2]!, a.formatVersion),
      ),
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
      const { proof, leaf } = proveInclusion(events, seq, cp.formatVersion);
      expect(checkInclusion(leaf, proof, cp.merkleRoot), `seq ${seq}`).toBe(true);
    }
  });

  it('rejects a proof for an event that was not there', () => {
    const events = chain(16);
    const cp = buildCheckpoint(events, key, GENESIS_DIGEST);
    const { proof } = proveInclusion(events, 5, cp.formatVersion);
    const forged = { ...events[4]!, actor_id: 'never-happened' };
    expect(
      checkInclusion(leafHash(leafBytes(forged, cp.formatVersion)), proof, cp.merkleRoot),
    ).toBe(false);
  });

  it('rejects a proof against a different checkpoint', () => {
    const a = chain(8);
    const cpB = buildCheckpoint(chain(9), key, GENESIS_DIGEST);
    const { proof, leaf } = proveInclusion(a, 3, cpB.formatVersion);
    expect(checkInclusion(leaf, proof, cpB.merkleRoot)).toBe(false);
  });

  it('refuses to prove a sequence outside the range', () => {
    expect(() => proveInclusion(chain(4), '99', 'kf.audit-checkpoint.v3')).toThrow(RangeError);
  });
});
