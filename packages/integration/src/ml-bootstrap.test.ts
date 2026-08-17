import { describe, expect, it } from 'vitest';
import { digest } from '@kf/canonicalization';
import { createMetricSegment, createRunLineage, type AggregateReference } from '@kf/ml-registry';

import {
  actionForAggregateReferenceRegistration,
  actionForMetricDefinitionRegistration,
  actionForMetricSegmentRegistration,
  actionForRunLineageRegistration,
  mlRegistryActionIdempotencyKey,
} from './ml.js';

const ORGANIZATION_ID = '11111111-1111-7111-8111-111111111111';
const REFERENCE_ID = '22222222-2222-7222-8222-222222222222';
const LINEAGE_ID = '33333333-3333-7333-8333-333333333333';
const DEFINITION_ID = '44444444-4444-7444-8444-444444444444';
const SEGMENT_ID = '55555555-5555-7555-8555-555555555555';
const SHA = 'a'.repeat(64);

function reference(kind: AggregateReference['kind'], authorityId: string): AggregateReference {
  return {
    organizationId: ORGANIZATION_ID,
    kind,
    authorityId,
    revisionId: 'revision-1',
    sha256: SHA,
    classificationId: 'internal',
    policyId: 'ml-default',
  };
}

describe('ML bootstrap action contracts', () => {
  it('binds an exact aggregate reference and stable replay key', () => {
    const intent = actionForAggregateReferenceRegistration({
      organizationId: ORGANIZATION_ID,
      referenceId: REFERENCE_ID,
      reference: reference('run', 'blut-run-0001'),
    });

    expect(intent).toEqual({
      actionType: 'register_ml_aggregate_reference',
      targetId: ORGANIZATION_ID,
      parameters: {
        referenceId: REFERENCE_ID,
        kind: 'run',
        authorityId: 'blut-run-0001',
        revisionId: 'revision-1',
        sha256: SHA,
        classificationId: 'internal',
        policyId: 'ml-default',
      },
    });
    expect(mlRegistryActionIdempotencyKey(intent)).toBe(
      `ml-register:aggregate-reference:${REFERENCE_ID}:${SHA}`,
    );
  });

  it('binds complete ordered lineage IDs to its canonical digest', () => {
    const run = reference('run', 'blut-run-0001');
    const code = reference('code', 'blut-code-0001');
    const recipe = reference('recipe', 'blut-recipe-0001');
    const environment = reference('environment', 'blut-environment-0001');
    const metricPolicy = reference('metric_policy', 'blut-policy-0001');
    const input = reference('input', 'blut-input-0001');
    const output = reference('candidate', 'blut-candidate-0001');
    const parent = reference('parent_model', 'blut-parent-0001');
    const lineage = createRunLineage({
      run,
      code,
      recipe,
      environment,
      metricPolicy,
      inputs: [input],
      outputs: [output],
      parentModels: [parent],
    });
    const intent = actionForRunLineageRegistration({
      organizationId: ORGANIZATION_ID,
      lineageId: LINEAGE_ID,
      runRefId: '60000000-0000-7000-8000-000000000001',
      codeRefId: '60000000-0000-7000-8000-000000000002',
      recipeRefId: '60000000-0000-7000-8000-000000000003',
      environmentRefId: '60000000-0000-7000-8000-000000000004',
      metricPolicyRefId: '60000000-0000-7000-8000-000000000005',
      inputRefIds: ['60000000-0000-7000-8000-000000000006'],
      outputRefIds: ['60000000-0000-7000-8000-000000000007'],
      parentModelRefIds: ['60000000-0000-7000-8000-000000000008'],
      lineageDigest: digest(lineage),
    });

    expect(intent.actionType).toBe('register_ml_run_lineage');
    expect(intent.parameters).toEqual({
      lineageId: LINEAGE_ID,
      runRefId: '60000000-0000-7000-8000-000000000001',
      codeRefId: '60000000-0000-7000-8000-000000000002',
      recipeRefId: '60000000-0000-7000-8000-000000000003',
      environmentRefId: '60000000-0000-7000-8000-000000000004',
      metricPolicyRefId: '60000000-0000-7000-8000-000000000005',
      inputRefIds: ['60000000-0000-7000-8000-000000000006'],
      outputRefIds: ['60000000-0000-7000-8000-000000000007'],
      parentModelRefIds: ['60000000-0000-7000-8000-000000000008'],
      lineageDigest: digest(lineage),
    });
  });

  it('closes metric-definition and v2 segment payloads', () => {
    const definition = actionForMetricDefinitionRegistration({
      organizationId: ORGANIZATION_ID,
      definitionId: DEFINITION_ID,
      definitionRefId: REFERENCE_ID,
      metricId: 'validation.loss',
      valueKind: 'number',
      unitId: 'ratio',
      allowedEnumIds: [],
    });
    expect(definition).toMatchObject({
      actionType: 'register_ml_metric_definition',
      targetId: ORGANIZATION_ID,
      parameters: {
        definitionId: DEFINITION_ID,
        definitionRefId: REFERENCE_ID,
        metricId: 'validation.loss',
        valueKind: 'number',
        unitId: 'ratio',
        allowedEnumIds: [],
      },
    });

    const segment = createMetricSegment({
      segment: reference('segment', 'blut-segment-0001'),
      run: reference('run', 'blut-run-0001'),
      ordinal: 1,
      firstSequence: 1,
      lastSequence: 1,
      eventCount: 1,
      eventDigests: [SHA],
    });
    const segmentIntent = actionForMetricSegmentRegistration({
      organizationId: ORGANIZATION_ID,
      segmentId: SEGMENT_ID,
      segmentRefId: REFERENCE_ID,
      runLineageId: LINEAGE_ID,
      segment,
    });
    expect(segmentIntent).toMatchObject({
      actionType: 'register_ml_metric_segment',
      parameters: {
        segmentId: SEGMENT_ID,
        segmentRefId: REFERENCE_ID,
        runLineageId: LINEAGE_ID,
        schemaVersion: 2,
        eventManifestDigest: segment.eventManifestDigest,
        metadataDigest: segment.metadataDigest,
      },
    });
  });

  it('rejects cross-organization and unsafe bootstrap values before dispatch', () => {
    expect(() =>
      actionForAggregateReferenceRegistration({
        organizationId: ORGANIZATION_ID,
        referenceId: REFERENCE_ID,
        reference: { ...reference('run', 'blut-run-0001'), organizationId: LINEAGE_ID },
      }),
    ).toThrow(/action organization/);
    expect(() =>
      actionForMetricDefinitionRegistration({
        organizationId: ORGANIZATION_ID,
        definitionId: DEFINITION_ID,
        definitionRefId: REFERENCE_ID,
        metricId: 'free text is forbidden',
        valueKind: 'number',
        unitId: 'ratio',
        allowedEnumIds: [],
      }),
    ).toThrow(/safe lowercase/);
  });
});
