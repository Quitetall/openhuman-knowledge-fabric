import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalBytes, digest } from '@kf/canonicalization';
import {
  createRunLineage,
  createMetricWriteAuthorizationClaim,
  createMetricSegment,
  signRunSeal,
  signPromotionReceipt,
  signPromotionRevocation,
  resolveGovernedAlias,
  verifyPromotionReceipt,
  verifyRunSeal,
  MetricEventJournal,
  MlRegistryRejected,
  type AggregateKind,
  type AggregateReference,
  type LegacySignedRunSeal,
  type MetricDefinition,
  type PromotionReceiptInput,
} from './index.js';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222';

function kindFor(authorityId: string): AggregateKind {
  if (authorityId.startsWith('run-')) return 'run';
  if (authorityId.startsWith('code-')) return 'code';
  if (authorityId.startsWith('recipe-')) return 'recipe';
  if (authorityId.startsWith('environment-')) return 'environment';
  if (authorityId.includes('policy-')) return 'metric_policy';
  if (authorityId.startsWith('input-')) return 'input';
  if (authorityId.startsWith('output-')) return 'output';
  if (authorityId.startsWith('segment-')) return 'segment';
  if (authorityId.includes('definition-')) return 'metric_definition';
  if (authorityId.startsWith('model-')) return 'candidate';
  throw new Error(`test fixture has no aggregate kind for ${authorityId}`);
}

function ref(authorityId: string, revisionId = 'revision-1'): AggregateReference {
  return {
    organizationId: ORGANIZATION_ID,
    kind: kindFor(authorityId),
    authorityId,
    revisionId,
    sha256: 'a'.repeat(64),
    classificationId: 'internal',
    policyId: 'ml-default',
  };
}

function scopedRef(
  kind: AggregateKind,
  authorityId: string,
  organizationId = ORGANIZATION_ID,
): AggregateReference {
  return {
    organizationId,
    kind,
    authorityId,
    revisionId: 'revision-1',
    sha256: 'a'.repeat(64),
    classificationId: 'internal',
    policyId: 'ml-default',
  } as AggregateReference;
}

describe('organization-scoped typed aggregate references', () => {
  it('accepts one complete organization lineage and rejects wrong kinds or mixed organizations', () => {
    const valid = {
      run: scopedRef('run', 'run-authority'),
      code: scopedRef('code', 'code-authority'),
      recipe: scopedRef('recipe', 'recipe-authority'),
      environment: scopedRef('environment', 'environment-authority'),
      metricPolicy: scopedRef('metric_policy', 'metric-policy-authority'),
      inputs: [scopedRef('input', 'input-authority')],
      outputs: [scopedRef('candidate', 'candidate-authority')],
      parentModels: [scopedRef('parent_model', 'parent-authority')],
    };

    expect(createRunLineage(valid).run.organizationId).toBe(ORGANIZATION_ID);
    expect(() =>
      createRunLineage({ ...valid, code: scopedRef('recipe', 'code-authority') }),
    ).toThrow(/code.*kind/i);
    expect(() =>
      createRunLineage({
        ...valid,
        inputs: [scopedRef('input', 'input-authority', OTHER_ORGANIZATION_ID)],
      }),
    ).toThrow(/organization/i);
    expect(() =>
      createRunLineage({
        ...valid,
        run: scopedRef(
          'run',
          'run-authority',
          'abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase(),
        ),
      }),
    ).toThrow(/canonical lowercase UUID/i);
  });
});

function completeLineage() {
  return createRunLineage({
    run: ref('run-authority'),
    code: ref('code-authority'),
    recipe: ref('recipe-authority'),
    environment: ref('environment-authority'),
    metricPolicy: ref('metric-policy-authority'),
    inputs: [ref('input-authority')],
    outputs: [ref('output-authority')],
    parentModels: [],
  });
}

describe('complete run lineage', () => {
  it('records every required aggregate without adding a subject, session, or locator', () => {
    const lineage = createRunLineage({
      run: ref('run-authority'),
      code: ref('code-authority'),
      recipe: ref('recipe-authority'),
      environment: ref('environment-authority'),
      metricPolicy: ref('metric-policy-authority'),
      inputs: [ref('input-authority')],
      outputs: [ref('output-authority')],
      parentModels: [],
    });

    expect(lineage).toEqual({
      schemaVersion: 'kf.ml.run-lineage.v1',
      run: ref('run-authority'),
      code: ref('code-authority'),
      recipe: ref('recipe-authority'),
      environment: ref('environment-authority'),
      metricPolicy: ref('metric-policy-authority'),
      inputs: [ref('input-authority')],
      outputs: [ref('output-authority')],
      parentModels: [],
    });
    expect(Object.isFrozen(lineage)).toBe(true);
    expect(Object.keys(lineage.run)).toEqual([
      'organizationId',
      'kind',
      'authorityId',
      'revisionId',
      'sha256',
      'classificationId',
      'policyId',
    ]);
  });

  it('fails closed when the lineage has no input aggregate', () => {
    expect(() =>
      createRunLineage({
        run: ref('run-authority'),
        code: ref('code-authority'),
        recipe: ref('recipe-authority'),
        environment: ref('environment-authority'),
        metricPolicy: ref('metric-policy-authority'),
        inputs: [],
        outputs: [ref('output-authority')],
        parentModels: [],
      }),
    ).toThrow(MlRegistryRejected);
  });
});

describe('metric-stream authorization provenance', () => {
  it('derives authorization digest from exact governed tuple instead of caller input', () => {
    const claim = createMetricWriteAuthorizationClaim({
      actionId: '77777777-7777-4777-8777-777777777777',
      organizationId: ORGANIZATION_ID,
      actorId: OTHER_ORGANIZATION_ID,
      actingRoleId: '33333333-3333-4333-8333-333333333333',
      runLineageId: '44444444-4444-4444-8444-444444444444',
      metricDefinitionId: '55555555-5555-4555-8555-555555555555',
      metricPolicyRefId: '66666666-6666-4666-8666-666666666666',
      authorizedAt: '2026-08-14T12:30:00.000Z',
    });

    expect(claim).toEqual({
      schemaVersion: 'kf.ml.metric-write-authorization.v2',
      actionId: '77777777-7777-4777-8777-777777777777',
      organizationId: ORGANIZATION_ID,
      actorId: OTHER_ORGANIZATION_ID,
      actingRoleId: '33333333-3333-4333-8333-333333333333',
      runLineageId: '44444444-4444-4444-8444-444444444444',
      metricDefinitionId: '55555555-5555-4555-8555-555555555555',
      metricPolicyRefId: '66666666-6666-4666-8666-666666666666',
      authorizedAt: '2026-08-14T12:30:00.000Z',
      authorizationDigest: 'cf4f8e819a042e0af5eb6ae02521fe7cf154f897d48741b0e62033a6980e3289',
    });
    expect(Object.isFrozen(claim)).toBe(true);
  });
});

describe('provisional metric events', () => {
  const numericDefinition: MetricDefinition = {
    reference: ref('metric-definition-authority'),
    metricId: 'validation.loss',
    valueKind: 'number',
    unitId: 'ratio',
    allowedValues: [],
  };

  it('appends a finite numeric event idempotently and keeps it provisional', () => {
    const journal = new MetricEventJournal();
    const input = {
      idempotencyKey: 'worker-01:000001',
      run: ref('run-authority'),
      sequence: 1,
      recordedAt: '2026-08-14T12:00:00.000Z',
      value: { kind: 'number' as const, number: 0.125 },
    };

    const first = journal.append(numericDefinition, input);
    const replay = journal.append(numericDefinition, input);

    expect(replay).toBe(first);
    expect(first.status).toBe('provisional');
    expect(first.eventDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(journal.entries()).toEqual([first]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.value)).toBe(true);
  });

  it('requires typed metric-definition and run references from one organization', () => {
    const journal = new MetricEventJournal();
    const input = {
      idempotencyKey: 'worker-01:typed',
      run: scopedRef('run', 'run-authority'),
      sequence: 1,
      recordedAt: '2026-08-14T12:00:00.000Z',
      value: { kind: 'number' as const, number: 0.125 },
    };
    const wrongKind = {
      ...numericDefinition,
      reference: scopedRef('evidence', 'metric-definition-authority'),
    };
    const wrongOrganization = {
      ...numericDefinition,
      reference: scopedRef(
        'metric_definition',
        'metric-definition-authority',
        OTHER_ORGANIZATION_ID,
      ),
    };

    expect(() => journal.append(wrongKind, input)).toThrow(/kind/i);
    expect(() => journal.append(wrongOrganization, input)).toThrow(/organization/i);
  });

  it('accepts only declared safe-enum identifiers', () => {
    const journal = new MetricEventJournal();
    const definition: MetricDefinition = {
      reference: ref('gate-definition-authority'),
      metricId: 'gate.outcome',
      valueKind: 'safe_enum',
      unitId: null,
      allowedValues: ['pass', 'fail_closed'],
    };
    const base = {
      run: ref('run-authority'),
      sequence: 2,
      recordedAt: '2026-08-14T12:01:00.000Z',
    };

    expect(
      journal.append(definition, {
        ...base,
        idempotencyKey: 'worker-01:000002',
        value: { kind: 'safe_enum', enumId: 'pass' },
      }).value,
    ).toEqual({ kind: 'safe_enum', enumId: 'pass' });
    expect(() =>
      journal.append(definition, {
        ...base,
        idempotencyKey: 'worker-01:000003',
        value: { kind: 'safe_enum', enumId: 'operator said probably fine' },
      }),
    ).toThrow(MlRegistryRejected);
  });

  it('stores timestamp metrics only in canonical UTC form', () => {
    const journal = new MetricEventJournal();
    const definition: MetricDefinition = {
      reference: ref('timestamp-definition-authority'),
      metricId: 'run.completed_at',
      valueKind: 'timestamp',
      unitId: null,
      allowedValues: [],
    };
    const base = {
      run: ref('run-authority'),
      sequence: 3,
      recordedAt: '2026-08-14T12:02:00.000Z',
    };

    expect(
      journal.append(definition, {
        ...base,
        idempotencyKey: 'worker-01:000004',
        value: { kind: 'timestamp', timestamp: '2026-08-14T12:01:59.123Z' },
      }).value,
    ).toEqual({ kind: 'timestamp', timestamp: '2026-08-14T12:01:59.123Z' });
    expect(() =>
      journal.append(definition, {
        ...base,
        idempotencyKey: 'worker-01:000005',
        value: { kind: 'timestamp', timestamp: '2026-08-14 12:01:59' },
      }),
    ).toThrow(MlRegistryRejected);
  });

  it('never overwrites a sequence or an idempotency key with different bytes', () => {
    const journal = new MetricEventJournal();
    const first = {
      idempotencyKey: 'worker-01:000010',
      run: ref('run-authority'),
      sequence: 10,
      recordedAt: '2026-08-14T12:10:00.000Z',
      value: { kind: 'number' as const, number: 0.5 },
    };
    journal.append(numericDefinition, first);

    expect(() =>
      journal.append(numericDefinition, {
        ...first,
        idempotencyKey: 'worker-02:000010',
        value: { kind: 'number', number: 0.75 },
      }),
    ).toThrow(/sequence 10/);
    expect(() =>
      journal.append(numericDefinition, {
        ...first,
        sequence: 11,
        value: { kind: 'number', number: 0.75 },
      }),
    ).toThrow(/idempotency key/);
    expect(journal.entries()).toHaveLength(1);
  });

  it.each(['text', 'path', 'subject', 'session', 'sample', 'label'])(
    'rejects the forbidden %s payload field instead of persisting free-form context',
    (forbiddenField) => {
      const journal = new MetricEventJournal();
      const value = {
        kind: 'number',
        number: 0.5,
        [forbiddenField]: 'must-not-enter-the-registry',
      } as unknown as { readonly kind: 'number'; readonly number: number };

      expect(() =>
        journal.append(numericDefinition, {
          idempotencyKey: `worker-03:${forbiddenField}`,
          run: ref('run-authority'),
          sequence: 20,
          recordedAt: '2026-08-14T12:20:00.000Z',
          value,
        }),
      ).toThrow(MlRegistryRejected);
    },
  );
});

describe('immutable metric segments', () => {
  it('binds each contiguous sequence to its exact ordered metric-event digest', () => {
    const eventDigests = ['1'.repeat(64), '2'.repeat(64)];
    const segment = createMetricSegment({
      segment: ref('segment-authority', 'segment-0001'),
      run: ref('run-authority'),
      ordinal: 1,
      firstSequence: 1,
      lastSequence: 2,
      eventCount: 2,
      eventDigests,
    });

    expect(segment.schemaVersion).toBe('kf.ml.metric-segment.v2');
    expect(segment.segment.sha256).toBe('a'.repeat(64));
    expect(segment.eventDigests).toEqual(eventDigests);
    expect(segment.eventManifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(segment.metadataDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(segment)).toBe(true);
    expect(Object.isFrozen(segment.eventDigests)).toBe(true);
    expect(
      createMetricSegment({
        segment: ref('segment-authority', 'segment-0001'),
        run: ref('run-authority'),
        ordinal: 1,
        firstSequence: 1,
        lastSequence: 2,
        eventCount: 2,
        eventDigests: [...eventDigests].reverse(),
      }).metadataDigest,
    ).not.toBe(segment.metadataDigest);
    expect(() =>
      createMetricSegment({
        segment: ref('segment-authority', 'segment-0002'),
        run: ref('run-authority'),
        ordinal: 2,
        firstSequence: 33,
        lastSequence: 64,
        eventCount: 31,
        eventDigests: Array.from({ length: 31 }, (_, index) =>
          (index + 3).toString(16).padStart(64, '0'),
        ),
      }),
    ).toThrow(MlRegistryRejected);
    expect(() =>
      createMetricSegment({
        segment: ref('segment-authority', 'segment-0002'),
        run: ref('run-authority'),
        ordinal: 2,
        firstSequence: 3,
        lastSequence: 4,
        eventCount: 2,
        eventDigests: ['3'.repeat(64)],
      }),
    ).toThrow(/event digest manifest/i);
  });

  it('requires segment and run kinds from one organization', () => {
    const valid = {
      segment: scopedRef('segment', 'segment-authority'),
      run: scopedRef('run', 'run-authority'),
      ordinal: 1,
      firstSequence: 1,
      lastSequence: 1,
      eventCount: 1,
      eventDigests: ['1'.repeat(64)],
    };

    expect(() =>
      createMetricSegment({ ...valid, segment: scopedRef('output', 'segment-authority') }),
    ).toThrow(/kind/i);
    expect(() =>
      createMetricSegment({
        ...valid,
        segment: scopedRef('segment', 'segment-authority', OTHER_ORGANIZATION_ID),
      }),
    ).toThrow(/organization/i);
  });
});

describe('JCS and Ed25519 run seals', () => {
  it('verifies signed lineage, segments, and exact ordered event manifest', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const segment = createMetricSegment({
      segment: ref('segment-authority', 'segment-0001'),
      run: ref('run-authority'),
      ordinal: 1,
      firstSequence: 1,
      lastSequence: 2,
      eventCount: 2,
      eventDigests: ['1'.repeat(64), '2'.repeat(64)],
    });
    const seal = signRunSeal(
      {
        lineage: completeLineage(),
        segments: [segment],
        sealedAt: '2026-08-14T12:30:00.000Z',
      },
      { id: 'kf-run-seal-key-1', privateKey },
    );
    const keys = new Map([['kf-run-seal-key-1', publicKey]]);

    expect(verifyRunSeal(seal, keys)).toEqual({ valid: true, findings: [] });
    expect(seal.schemaVersion).toBe('kf.ml.run-seal.v2');
    expect(seal.eventManifestDigest).toBe(digest(['1'.repeat(64), '2'.repeat(64)]));
    expect(verifyRunSeal({ ...seal, eventCount: seal.eventCount + 1 }, keys)).toEqual(
      expect.objectContaining({ valid: false }),
    );
    expect(
      verifyRunSeal({ ...seal, signature: `${seal.signature.slice(0, -2)}!!` }, keys).valid,
    ).toBe(false);
    expect(
      verifyRunSeal({ ...seal, run: { ...seal.run, kind: 'evidence' } }, keys).findings,
    ).toContain('malformed_seal');
    expect(
      verifyRunSeal({ ...seal, eventManifestDigest: 'f'.repeat(64) }, keys).findings,
    ).toContain('seal_digest_mismatch');
  });

  it('continues to verify immutable v1 run-seal records', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const unsigned = {
      schemaVersion: 'kf.ml.run-seal.v1' as const,
      run: ref('run-authority'),
      lineageDigest: '1'.repeat(64),
      segmentDigests: ['2'.repeat(64)],
      eventCount: 1,
      sealedAt: '2026-08-14T12:30:00.000Z',
      signingKeyId: 'kf-run-seal-key-v1',
    };
    const legacy: LegacySignedRunSeal = {
      ...unsigned,
      sealDigest: digest(unsigned),
      signature: edSign(null, canonicalBytes(unsigned), privateKey).toString('base64'),
    };

    expect(verifyRunSeal(legacy, new Map([[unsigned.signingKeyId, publicKey]]))).toEqual({
      valid: true,
      findings: [],
    });
  });
});

describe('KF-governed promotion aliases', () => {
  it('binds organization, risk tier, complete immutable evidence, and supplied authority decisions', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const technicalDecision = scopedRef('evidence', 'technical-decision-authority');
    const qualityDecision = scopedRef('evidence', 'quality-decision-authority');
    const evaluation = scopedRef('evidence', 'evaluation-authority');
    const base = {
      organizationId: ORGANIZATION_ID,
      aliasId: 'research.encoder',
      candidate: scopedRef('candidate', 'candidate-authority'),
      runSealDigest: 'b'.repeat(64),
      policy: scopedRef('metric_policy', 'promotion-policy-authority'),
      riskTier: 'research' as const,
      technicalAuthorityDecision: technicalDecision,
      qualityAuthorityDecision: qualityDecision,
      promotedAt: '2026-08-14T13:00:00.000Z',
    };
    const key = { id: 'kf-promotion-key-1', privateKey };
    const receipt = signPromotionReceipt(
      { ...base, evidence: [technicalDecision, qualityDecision, evaluation] },
      key,
    );
    const reordered = signPromotionReceipt(
      { ...base, evidence: [evaluation, qualityDecision, technicalDecision] },
      key,
    );

    expect(receipt.organizationId).toBe(ORGANIZATION_ID);
    expect(receipt.riskTier).toBe('research');
    expect(receipt.technicalAuthorityDecision).toEqual(technicalDecision);
    expect(receipt.qualityAuthorityDecision).toEqual(qualityDecision);
    expect(receipt.evidence).toHaveLength(3);
    expect(Object.isFrozen(receipt.evidence)).toBe(true);
    expect(receipt.evidenceSetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.receiptDigest).toBe(reordered.receiptDigest);
    expect(verifyPromotionReceipt(receipt, new Map([['kf-promotion-key-1', publicKey]]))).toEqual({
      valid: true,
      findings: [],
    });
    expect(
      verifyPromotionReceipt(
        { ...receipt, signature: `${receipt.signature.slice(0, -2)}!!` },
        new Map([['kf-promotion-key-1', publicKey]]),
      ).valid,
    ).toBe(false);
    expect(
      verifyPromotionReceipt(
        { ...receipt, evidenceSetDigest: '0'.repeat(64) },
        new Map([['kf-promotion-key-1', publicKey]]),
      ).valid,
    ).toBe(false);
  });

  it('requires independent Quality Authority evidence for every descriptive risk tier', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const technicalDecision = scopedRef('evidence', 'technical-decision-authority');
    const qualityDecision = scopedRef('evidence', 'quality-decision-authority');
    const input = {
      organizationId: ORGANIZATION_ID,
      aliasId: 'regulated.encoder',
      candidate: scopedRef('candidate', 'candidate-authority'),
      runSealDigest: 'b'.repeat(64),
      policy: scopedRef('metric_policy', 'promotion-policy-authority'),
      evidence: [technicalDecision],
      riskTier: 'regulated' as const,
      technicalAuthorityDecision: technicalDecision,
      qualityAuthorityDecision: null,
      promotedAt: '2026-08-14T13:00:00.000Z',
    } as unknown as PromotionReceiptInput;
    const key = { id: 'kf-promotion-key-1', privateKey };

    expect(() => signPromotionReceipt(input, key)).toThrow(/Quality Authority/i);
    expect(() => signPromotionReceipt({ ...input, riskTier: 'research' }, key)).toThrow(
      /Quality Authority/i,
    );
    expect(() =>
      signPromotionReceipt(
        {
          ...input,
          riskTier: 'high_risk',
          qualityAuthorityDecision: qualityDecision,
          evidence: [technicalDecision],
        },
        key,
      ),
    ).toThrow(/evidence set/i);
    expect(() =>
      signPromotionReceipt(
        {
          ...input,
          qualityAuthorityDecision: qualityDecision,
          evidence: [technicalDecision, qualityDecision],
        },
        key,
      ),
    ).not.toThrow();
  });

  it('rejects promotion evidence from another organization', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const technicalDecision = scopedRef('evidence', 'technical-decision-authority');
    const qualityDecision = scopedRef('evidence', 'quality-decision-authority');
    expect(() =>
      signPromotionReceipt(
        {
          organizationId: ORGANIZATION_ID,
          aliasId: 'research.encoder',
          candidate: scopedRef('candidate', 'candidate-authority'),
          runSealDigest: 'b'.repeat(64),
          policy: scopedRef('metric_policy', 'promotion-policy-authority'),
          evidence: [
            technicalDecision,
            qualityDecision,
            scopedRef('evidence', 'foreign-evaluation', OTHER_ORGANIZATION_ID),
          ],
          riskTier: 'research',
          technicalAuthorityDecision: technicalDecision,
          qualityAuthorityDecision: qualityDecision,
          promotedAt: '2026-08-14T13:00:00.000Z',
        },
        { id: 'kf-promotion-key-1', privateKey },
      ),
    ).toThrow(/organization/i);
  });

  it('resolves identical alias names independently inside each organization', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = { id: 'kf-promotion-key-1', privateKey };
    const keys = new Map([['kf-promotion-key-1', publicKey]]);
    const makeReceipt = (organizationId: string, revisionId: string) => {
      const technicalDecision = scopedRef(
        'evidence',
        `technical-decision-${revisionId}`,
        organizationId,
      );
      const qualityDecision = scopedRef(
        'evidence',
        `quality-decision-${revisionId}`,
        organizationId,
      );
      return signPromotionReceipt(
        {
          organizationId,
          aliasId: 'production.encoder',
          candidate: {
            ...scopedRef('candidate', 'candidate-authority', organizationId),
            revisionId,
          },
          runSealDigest: 'b'.repeat(64),
          policy: scopedRef('metric_policy', 'promotion-policy-authority', organizationId),
          evidence: [technicalDecision, qualityDecision],
          riskTier: 'research',
          technicalAuthorityDecision: technicalDecision,
          qualityAuthorityDecision: qualityDecision,
          promotedAt: '2026-08-14T13:00:00.000Z',
        },
        key,
      );
    };
    const first = makeReceipt(ORGANIZATION_ID, 'candidate-a');
    const second = makeReceipt(OTHER_ORGANIZATION_ID, 'candidate-b');

    expect(
      resolveGovernedAlias(ORGANIZATION_ID, 'production.encoder', [first, second], [], keys),
    ).toEqual(
      expect.objectContaining({
        status: 'active',
        organizationId: ORGANIZATION_ID,
        candidate: expect.objectContaining({ revisionId: 'candidate-a' }),
      }),
    );
    expect(
      resolveGovernedAlias(OTHER_ORGANIZATION_ID, 'production.encoder', [first, second], [], keys),
    ).toEqual(
      expect.objectContaining({
        status: 'active',
        organizationId: OTHER_ORGANIZATION_ID,
        candidate: expect.objectContaining({ revisionId: 'candidate-b' }),
      }),
    );
  });

  it('resolves only a KF-signed receipt and leaves a revoked latest alias unassigned', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = { id: 'kf-promotion-key-1', privateKey };
    const keys = new Map([['kf-promotion-key-1', publicKey]]);
    const technicalDecision = scopedRef('evidence', 'technical-decision-authority');
    const qualityDecision = scopedRef('evidence', 'quality-decision-authority');
    const receipt = signPromotionReceipt(
      {
        organizationId: ORGANIZATION_ID,
        aliasId: 'production.encoder',
        candidate: ref('model-authority', 'checkpoint-42'),
        runSealDigest: 'b'.repeat(64),
        policy: ref('promotion-policy-authority'),
        evidence: [technicalDecision, qualityDecision],
        riskTier: 'research',
        technicalAuthorityDecision: technicalDecision,
        qualityAuthorityDecision: qualityDecision,
        promotedAt: '2026-08-14T13:00:00.000Z',
      },
      key,
    );

    expect(
      resolveGovernedAlias(ORGANIZATION_ID, 'production.encoder', [receipt], [], keys),
    ).toEqual({
      status: 'active',
      organizationId: ORGANIZATION_ID,
      aliasId: 'production.encoder',
      candidate: ref('model-authority', 'checkpoint-42'),
      receiptDigest: receipt.receiptDigest,
      findings: [],
    });

    const revocation = signPromotionRevocation(
      {
        organizationId: ORGANIZATION_ID,
        aliasId: 'production.encoder',
        receiptDigest: receipt.receiptDigest,
        reasonCode: 'evidence_invalid',
        revokedAt: '2026-08-14T13:05:00.000Z',
      },
      key,
    );
    expect(
      resolveGovernedAlias(
        ORGANIZATION_ID,
        'production.encoder',
        [receipt],
        [{ ...revocation, signature: `${revocation.signature.slice(0, -2)}!!` }],
        keys,
      ).status,
    ).toBe('invalid');
    expect(
      resolveGovernedAlias(ORGANIZATION_ID, 'production.encoder', [receipt], [revocation], keys),
    ).toEqual({
      status: 'revoked',
      organizationId: ORGANIZATION_ID,
      aliasId: 'production.encoder',
      receiptDigest: receipt.receiptDigest,
      findings: [],
    });
  });
});
