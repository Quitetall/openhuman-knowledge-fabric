import type { JsonValue } from '@kf/canonicalization';

import {
  ML_ACTION_TYPES,
  type AggregateReferenceRegistrationInput,
  type MetricEventAppendInput,
  type MetricDefinitionRegistrationInput,
  type MetricSegmentRegistrationInput,
  type MetricStreamAuthorizationInput,
  type MlActionIntent,
  type MlPromotionActionIntent,
  type PromotionAuthorizationInput,
  type RunLineageRegistrationInput,
} from './contracts.js';
import {
  rejected,
  requireAliasId,
  requireAuthorityKind,
  requireDigest,
  requireGovernedId,
  requireRiskTier,
  requireSafeId,
  requireTimestamp,
  requireUuid,
} from './validation.js';

/** Register one immutable opaque aggregate reference; no governed identifier is allocated. */
export function actionForAggregateReferenceRegistration(
  input: AggregateReferenceRegistrationInput,
): MlActionIntent {
  requireUuid(input.organizationId, 'organizationId');
  requireUuid(input.referenceId, 'referenceId');
  if (input.reference.organizationId !== input.organizationId) {
    rejected('aggregate reference must belong to the action organization');
  }
  requireSafeId(input.reference.authorityId, 'reference.authorityId');
  requireSafeId(input.reference.revisionId, 'reference.revisionId');
  requireDigest(input.reference.sha256, 'reference.sha256');
  requireGovernedId(input.reference.classificationId, 'reference.classificationId');
  requireGovernedId(input.reference.policyId, 'reference.policyId');
  return {
    actionType: ML_ACTION_TYPES.registerAggregateReference,
    targetId: input.organizationId,
    parameters: {
      referenceId: input.referenceId,
      kind: input.reference.kind,
      authorityId: input.reference.authorityId,
      revisionId: input.reference.revisionId,
      sha256: input.reference.sha256,
      classificationId: input.reference.classificationId,
      policyId: input.reference.policyId,
    },
  };
}

export function actionForRunLineageRegistration(
  input: RunLineageRegistrationInput,
): MlActionIntent {
  requireUuid(input.organizationId, 'organizationId');
  for (const [field, value] of Object.entries({
    lineageId: input.lineageId,
    runRefId: input.runRefId,
    codeRefId: input.codeRefId,
    recipeRefId: input.recipeRefId,
    environmentRefId: input.environmentRefId,
    metricPolicyRefId: input.metricPolicyRefId,
  }))
    requireUuid(value, field);
  const arrays = [input.inputRefIds, input.outputRefIds, input.parentModelRefIds];
  if (input.inputRefIds.length === 0 || input.outputRefIds.length === 0) {
    rejected('run lineage requires at least one input and output reference');
  }
  for (const [arrayIndex, values] of arrays.entries()) {
    values.forEach((value, index) => requireUuid(value, `referenceIds[${arrayIndex}][${index}]`));
    if (new Set(values).size !== values.length) rejected('run lineage member IDs must be unique');
  }
  requireDigest(input.lineageDigest, 'lineageDigest');
  return {
    actionType: ML_ACTION_TYPES.registerRunLineage,
    targetId: input.organizationId,
    parameters: {
      lineageId: input.lineageId,
      runRefId: input.runRefId,
      codeRefId: input.codeRefId,
      recipeRefId: input.recipeRefId,
      environmentRefId: input.environmentRefId,
      metricPolicyRefId: input.metricPolicyRefId,
      inputRefIds: [...input.inputRefIds],
      outputRefIds: [...input.outputRefIds],
      parentModelRefIds: [...input.parentModelRefIds],
      lineageDigest: input.lineageDigest,
    },
  };
}

export function actionForMetricDefinitionRegistration(
  input: MetricDefinitionRegistrationInput,
): MlActionIntent {
  requireUuid(input.organizationId, 'organizationId');
  requireUuid(input.definitionId, 'definitionId');
  requireUuid(input.definitionRefId, 'definitionRefId');
  requireGovernedId(input.metricId, 'metricId');
  if (input.unitId !== null) requireGovernedId(input.unitId, 'unitId');
  input.allowedEnumIds.forEach((value, index) =>
    requireGovernedId(value, `allowedEnumIds[${index}]`),
  );
  if (new Set(input.allowedEnumIds).size !== input.allowedEnumIds.length) {
    rejected('allowedEnumIds must be unique');
  }
  if (
    (input.valueKind === 'number' && (input.unitId === null || input.allowedEnumIds.length > 0)) ||
    (input.valueKind === 'safe_enum' &&
      (input.unitId !== null || input.allowedEnumIds.length === 0)) ||
    (input.valueKind === 'timestamp' && (input.unitId !== null || input.allowedEnumIds.length > 0))
  )
    rejected('metric definition does not match its value kind');
  return {
    actionType: ML_ACTION_TYPES.registerMetricDefinition,
    targetId: input.organizationId,
    parameters: {
      definitionId: input.definitionId,
      definitionRefId: input.definitionRefId,
      metricId: input.metricId,
      valueKind: input.valueKind,
      unitId: input.unitId,
      allowedEnumIds: [...input.allowedEnumIds],
    },
  };
}

export function actionForMetricSegmentRegistration(
  input: MetricSegmentRegistrationInput,
): MlActionIntent {
  requireUuid(input.organizationId, 'organizationId');
  requireUuid(input.segmentId, 'segmentId');
  requireUuid(input.segmentRefId, 'segmentRefId');
  requireUuid(input.runLineageId, 'runLineageId');
  if (
    input.segment.run.organizationId !== input.organizationId ||
    input.segment.segment.organizationId !== input.organizationId
  ) {
    rejected('metric segment must belong to the action organization');
  }
  requireDigest(input.segment.eventManifestDigest, 'segment.eventManifestDigest');
  requireDigest(input.segment.metadataDigest, 'segment.metadataDigest');
  return {
    actionType: ML_ACTION_TYPES.registerMetricSegment,
    targetId: input.organizationId,
    parameters: {
      segmentId: input.segmentId,
      segmentRefId: input.segmentRefId,
      runLineageId: input.runLineageId,
      schemaVersion: 2,
      ordinal: input.segment.ordinal,
      firstSequence: input.segment.firstSequence,
      lastSequence: input.segment.lastSequence,
      eventCount: input.segment.eventCount,
      eventDigests: [...input.segment.eventDigests],
      eventManifestDigest: input.segment.eventManifestDigest,
      metadataDigest: input.segment.metadataDigest,
    },
  };
}

/** Stable dispatcher replay key for each immutable ML registry atom. */
export function mlRegistryActionIdempotencyKey(intent: MlActionIntent): string {
  const value = intent.parameters;
  switch (intent.actionType) {
    case ML_ACTION_TYPES.registerAggregateReference:
      return `ml-register:aggregate-reference:${String(value['referenceId'])}:${String(value['sha256'])}`;
    case ML_ACTION_TYPES.registerRunLineage:
      return `ml-register:run-lineage:${String(value['lineageDigest'])}`;
    case ML_ACTION_TYPES.registerMetricDefinition:
      return `ml-register:metric-definition:${String(value['definitionId'])}:${String(value['definitionRefId'])}`;
    case ML_ACTION_TYPES.registerMetricSegment:
      return `ml-register:metric-segment:${String(value['metadataDigest'])}`;
    default:
      rejected(`${intent.actionType} is not an ML registry registration action`);
  }
}

/** Build the complete payload for generic POST /actions/authorize_ml_metric_stream. */
export function actionForMetricStreamAuthorization(
  input: MetricStreamAuthorizationInput,
): MlActionIntent {
  requireUuid(input.organizationId, 'organizationId');
  requireUuid(input.authorizedActorId, 'authorizedActorId');
  requireUuid(input.authorizedRoleId, 'authorizedRoleId');
  requireUuid(input.runLineageId, 'runLineageId');
  requireUuid(input.metricDefinitionId, 'metricDefinitionId');
  requireUuid(input.metricPolicyRefId, 'metricPolicyRefId');
  return {
    actionType: ML_ACTION_TYPES.authorizeMetricStream,
    targetId: input.organizationId,
    parameters: {
      authorizedActorId: input.authorizedActorId,
      authorizedRoleId: input.authorizedRoleId,
      runLineageId: input.runLineageId,
      metricDefinitionId: input.metricDefinitionId,
      metricPolicyRefId: input.metricPolicyRefId,
    },
  };
}

/** Build the complete append action from a validated canonical ML event. */
export function actionForMetricEventAppend(input: MetricEventAppendInput): MlActionIntent {
  requireUuid(input.organizationId, 'organizationId');
  requireUuid(input.runLineageId, 'runLineageId');
  requireUuid(input.metricDefinitionId, 'metricDefinitionId');
  requireDigest(input.event.eventDigest, 'event.eventDigest');
  if (input.event.run.organizationId !== input.organizationId) {
    rejected('metric event run must belong to the action organization');
  }
  return {
    actionType: ML_ACTION_TYPES.appendMetricEvent,
    targetId: input.organizationId,
    parameters: {
      runLineageId: input.runLineageId,
      metricDefinitionId: input.metricDefinitionId,
      idempotencyKey: input.event.idempotencyKey,
      sequence: input.event.sequence,
      recordedAt: input.event.recordedAt,
      value: input.event.value as JsonValue,
      eventDigest: input.event.eventDigest,
    },
  };
}

/** Build a human promotion-decision action. Decision object identity is server-created. */
export function actionForPromotionAuthorization(
  input: PromotionAuthorizationInput,
): MlPromotionActionIntent {
  requireAliasId(input.aliasId, 'aliasId');
  requireUuid(input.candidateRefId, 'candidateRefId');
  requireUuid(input.runSealId, 'runSealId');
  requireUuid(input.policyRefId, 'policyRefId');
  requireRiskTier(input.riskTier, 'riskTier');
  requireAuthorityKind(input.authorityKind, 'authorityKind');
  if (input.validUntil !== undefined) requireTimestamp(input.validUntil, 'validUntil');
  return {
    actionType: ML_ACTION_TYPES.authorizePromotion,
    targetIds: [],
    parameters: {
      aliasId: input.aliasId,
      candidateRefId: input.candidateRefId,
      runSealId: input.runSealId,
      policyRefId: input.policyRefId,
      riskTier: input.riskTier,
      authorityKind: input.authorityKind,
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
    },
  };
}

/** Stable, globally-scoped dispatcher replay key for one canonical metric event. */
export function metricEventActionIdempotencyKey(eventDigest: string): string {
  return `ml-event:${requireDigest(eventDigest, 'eventDigest')}`;
}
