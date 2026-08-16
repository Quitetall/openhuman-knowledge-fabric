import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createMetricSegment,
  createRunLineage,
  resolveGovernedAlias,
  signPromotionReceipt,
  signPromotionRevocation,
  signRunSeal,
  verifyRunSeal,
  type AggregateKind,
  type AggregateReference,
} from './index.js';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

function reference(kind: AggregateKind, authorityId: string): AggregateReference {
  return {
    organizationId: ORGANIZATION_ID,
    kind,
    authorityId,
    revisionId: 'revision-1',
    sha256: 'a'.repeat(64),
    classificationId: 'internal',
    policyId: 'ml-default',
  };
}

function noncanonicalBase64PadBits(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const index = alphabet.indexOf(value.at(-3) ?? '');
  if (index < 0 || index % 16 !== 0) throw new Error('test fixture is not one-byte-tail base64');
  return `${value.slice(0, -3)}${alphabet[index + 1]}==`;
}

function runBasis() {
  const run = reference('run', 'run-timestamp-wire');
  const lineage = createRunLineage({
    run,
    code: reference('code', 'code-timestamp-wire'),
    recipe: reference('recipe', 'recipe-timestamp-wire'),
    environment: reference('environment', 'environment-timestamp-wire'),
    metricPolicy: reference('metric_policy', 'policy-timestamp-wire'),
    inputs: [reference('input', 'input-timestamp-wire')],
    outputs: [reference('output', 'output-timestamp-wire')],
    parentModels: [],
  });
  const segment = createMetricSegment({
    segment: reference('segment', 'segment-timestamp-wire'),
    run,
    ordinal: 1,
    firstSequence: 1,
    lastSequence: 1,
    eventCount: 1,
    eventDigests: ['1'.repeat(64)],
  });
  return { lineage, segment };
}

describe('governed ML timestamp and base64 wire domain', () => {
  it('rejects extended/year-zero timestamp spellings and noncanonical signature pad bits', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const { lineage, segment } = runBasis();
    const key = { id: 'run-seal-timestamp-wire-key', privateKey };

    for (const sealedAt of ['0000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z']) {
      expect(() => signRunSeal({ lineage, segments: [segment], sealedAt }, key)).toThrow(
        /four-digit-year/i,
      );
    }

    const seal = signRunSeal(
      { lineage, segments: [segment], sealedAt: '2026-08-14T12:30:00.000Z' },
      key,
    );
    expect(
      verifyRunSeal(
        { ...seal, signature: noncanonicalBase64PadBits(seal.signature) },
        new Map([[key.id, publicKey]]),
      ),
    ).toEqual({ valid: false, findings: ['malformed_seal'] });
  });

  it('evaluates receipt and revocation effectivity at one explicit instant', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = { id: 'promotion-effectivity-key', privateKey };
    const technical = reference('evidence', 'technical-effectivity');
    const quality = reference('evidence', 'quality-effectivity');
    const receipt = signPromotionReceipt(
      {
        organizationId: ORGANIZATION_ID,
        aliasId: 'production.effectivity',
        candidate: reference('candidate', 'candidate-effectivity'),
        runSealDigest: 'b'.repeat(64),
        policy: reference('metric_policy', 'policy-effectivity'),
        evidence: [technical, quality],
        riskTier: 'research',
        technicalAuthorityDecision: technical,
        qualityAuthorityDecision: quality,
        promotedAt: '2026-08-16T00:00:00.000Z',
      },
      key,
    );
    const revocation = signPromotionRevocation(
      {
        organizationId: ORGANIZATION_ID,
        aliasId: receipt.aliasId,
        receiptDigest: receipt.receiptDigest,
        reasonCode: 'operator_withdrawal',
        revokedAt: '2026-08-17T00:00:00.000Z',
      },
      key,
    );
    const publicKeys = new Map([[key.id, publicKey]]);

    expect(
      resolveGovernedAlias(
        ORGANIZATION_ID,
        receipt.aliasId,
        [receipt],
        [revocation],
        publicKeys,
        '2026-08-15T23:59:59.999Z',
      ).status,
    ).toBe('unassigned');
    expect(
      resolveGovernedAlias(
        ORGANIZATION_ID,
        receipt.aliasId,
        [receipt],
        [revocation],
        publicKeys,
        '2026-08-16T00:00:00.000Z',
      ).status,
    ).toBe('active');
    expect(
      resolveGovernedAlias(
        ORGANIZATION_ID,
        receipt.aliasId,
        [receipt],
        [revocation],
        publicKeys,
        '2026-08-17T00:00:00.000Z',
      ).status,
    ).toBe('revoked');
  });
});
