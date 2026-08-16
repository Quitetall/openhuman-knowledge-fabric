import {
  ActionRejected,
  type ActionEffect,
  type ActionMaterializer,
  type PreconditionCheck,
} from '@kf/actions';

import {
  requireMetricStreamAuthorization,
  requireMlRegistryRecorder,
  requirePromotionAuthority,
  requireTechnicalAuthority,
} from './authority.js';
import { ML_ACTION_TYPES, type MlActionAtoms } from './contracts.js';
import {
  payloadPositiveInteger,
  payloadNullableString,
  payloadStringArray,
  payloadString,
  rejected,
  requireOrganizationTarget,
  requirePromotionCreationTarget,
  validateAggregateReferencePayload,
  validateAuthorizationPayload,
  validateEventPayload,
  validateMetricDefinitionPayload,
  validateMetricSegmentPayload,
  validatePromotionPayload,
  validateRunLineagePayload,
} from './validation.js';

/**
 * Compose ML registry mutations into the dispatcher transaction.
 *
 * Application checks make refusals useful to callers. SECURITY DEFINER wrappers repeat all
 * authority and digest checks at database seam; these checks are not final authority.
 */
export function createMlActionAtoms(): MlActionAtoms {
  const registryPrecondition = (validate: (request: Parameters<PreconditionCheck>[1]) => void): PreconditionCheck =>
    async (tx, request, objects) => {
      requireOrganizationTarget(request, objects);
      validate(request);
      await requireMlRegistryRecorder(tx, request);
    };
  const authorizePrecondition: PreconditionCheck = async (tx, request, objects) => {
    requireOrganizationTarget(request, objects);
    validateAuthorizationPayload(request);
    await requireTechnicalAuthority(tx, request);
  };
  const appendPrecondition: PreconditionCheck = async (tx, request, objects) => {
    requireOrganizationTarget(request, objects);
    validateEventPayload(request);
    await requireMetricStreamAuthorization(tx, request);
  };
  const promotionPrecondition: PreconditionCheck = async (tx, request, objects) => {
    validatePromotionPayload(request);
    requirePromotionCreationTarget(request, objects);
    if (request.reason?.trim().length === 0 || request.reason === undefined) {
      throw new ActionRejected(
        'reason_required',
        'authorize_ml_promotion requires a nonblank human decision reason',
      );
    }
    await requirePromotionAuthority(tx, request);
  };

  const promotionMaterializer: ActionMaterializer = async (tx, request) => {
    validatePromotionPayload(request);
    if (request.targetIds.length !== 0) {
      rejected('authorize_ml_promotion is a creation action and accepts no initial targets');
    }
    const basis = await tx.maybeOne<{ classification_id: string | null }>(
      `select (array_agg(reference.classification_id order by classification.rank desc))[1]
                as classification_id
         from ml.run_seal seal
         join ml.run_lineage lineage on lineage.id = seal.run_lineage_id
         join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
         join ml.run_lineage_output output
           on output.run_lineage_id = lineage.id
          and output.aggregate_ref_id = $1
         join ml.aggregate_reference candidate
           on candidate.id = output.aggregate_ref_id
          and candidate.aggregate_kind = 'candidate'
         join ml.aggregate_reference policy
           on policy.id = lineage.metric_policy_ref_id
          and policy.id = $3
          and policy.aggregate_kind = 'metric_policy'
         cross join lateral (values (run_ref.id), (candidate.id), (policy.id)) ids(reference_id)
         join ml.aggregate_reference reference on reference.id = ids.reference_id
         join registry.classification classification
           on classification.id = reference.classification_id
        where seal.id = $2
          and run_ref.organization_id = $4
          and candidate.organization_id = $4
          and policy.organization_id = $4`,
      [
        payloadString(request, 'candidateRefId'),
        payloadString(request, 'runSealId'),
        payloadString(request, 'policyRefId'),
        request.organizationId,
      ],
    );
    if (basis === undefined || basis.classification_id === null) {
      throw new ActionRejected(
        'object_not_visible',
        'promotion candidate, sealed run, or exact policy is unavailable',
      );
    }
    const { version } = await tx.one<{ version: string }>(
      'select version from registry.schema_release where is_current',
    );
    const row = await tx.one<{ id: string }>(
      `insert into core.object
         (object_type, authority_domain, lifecycle_state, classification, retention_class,
          schema_version, organization_id, title, created_by, updated_by)
       values ('ml_promotion_decision','qms','recorded',$1,'quality_record',$2,$3,$4,$5,$5)
       returning id`,
      [
        basis.classification_id,
        version,
        request.organizationId,
        `${payloadString(request, 'authorityKind')} ML promotion decision for ${payloadString(request, 'aliasId')}`,
        request.actorId,
      ],
    );
    return [row.id];
  };

  const authorize: ActionEffect = async (tx, request) => {
    validateAuthorizationPayload(request);
    await tx.query(`select * from ml.authorize_metric_stream_action($1, $2, $3, $4, $5)`, [
      payloadString(request, 'authorizedActorId'),
      payloadString(request, 'authorizedRoleId'),
      payloadString(request, 'runLineageId'),
      payloadString(request, 'metricDefinitionId'),
      payloadString(request, 'metricPolicyRefId'),
    ]);
  };

  const append: ActionEffect = async (tx, request) => {
    const value = validateEventPayload(request);
    await tx.query(
      `select * from ml.append_metric_event_action(
         $1, $2, $3, $4::bigint, $5::timestamptz,
         $6::double precision, $7::text, $8::timestamptz, $9
       )`,
      [
        payloadString(request, 'runLineageId'),
        payloadString(request, 'metricDefinitionId'),
        payloadString(request, 'idempotencyKey'),
        payloadPositiveInteger(request, 'sequence'),
        payloadString(request, 'recordedAt'),
        value.kind === 'number' ? value.number : null,
        value.kind === 'safe_enum' ? value.enumId : null,
        value.kind === 'timestamp' ? value.timestamp : null,
        payloadString(request, 'eventDigest'),
      ],
    );
  };

  const authorizePromotion: ActionEffect = async (tx, request, objects) => {
    validatePromotionPayload(request);
    requirePromotionCreationTarget(request, objects);
    await tx.query('select * from ml.authorize_promotion_decision_action($1)', [objects[0]!.id]);
  };

  const registerAggregateReference: ActionEffect = async (tx, request) => {
    validateAggregateReferencePayload(request);
    await tx.query(
      `select * from ml.register_aggregate_reference_action($1,$2,$3,$4,$5,$6,$7)`,
      [
        payloadString(request, 'referenceId'), payloadString(request, 'kind'),
        payloadString(request, 'authorityId'), payloadString(request, 'revisionId'),
        payloadString(request, 'sha256'), payloadString(request, 'classificationId'),
        payloadString(request, 'policyId'),
      ],
    );
  };
  const registerRunLineage: ActionEffect = async (tx, request) => {
    validateRunLineagePayload(request);
    await tx.query(
      `select * from ml.register_run_lineage_action(
         $1,$2,$3,$4,$5,$6,$7::uuid[],$8::uuid[],$9::uuid[],$10
       )`,
      [
        payloadString(request, 'lineageId'), payloadString(request, 'runRefId'),
        payloadString(request, 'codeRefId'), payloadString(request, 'recipeRefId'),
        payloadString(request, 'environmentRefId'), payloadString(request, 'metricPolicyRefId'),
        payloadStringArray(request, 'inputRefIds', { requireOne: true, uuid: true }),
        payloadStringArray(request, 'outputRefIds', { requireOne: true, uuid: true }),
        payloadStringArray(request, 'parentModelRefIds', { uuid: true }),
        payloadString(request, 'lineageDigest'),
      ],
    );
  };
  const registerMetricDefinition: ActionEffect = async (tx, request) => {
    validateMetricDefinitionPayload(request);
    await tx.query(
      `select * from ml.register_metric_definition_action($1,$2,$3,$4,$5,$6::text[])`,
      [
        payloadString(request, 'definitionId'), payloadString(request, 'definitionRefId'),
        payloadString(request, 'metricId'), payloadString(request, 'valueKind'),
        payloadNullableString(request, 'unitId'), payloadStringArray(request, 'allowedEnumIds'),
      ],
    );
  };
  const registerMetricSegment: ActionEffect = async (tx, request) => {
    validateMetricSegmentPayload(request);
    await tx.query(
      `select * from ml.register_metric_segment_action(
         $1,$2,$3,$4,$5::bigint,$6::bigint,$7::bigint,$8::text[],$9,$10
       )`,
      [
        payloadString(request, 'segmentId'), payloadString(request, 'segmentRefId'),
        payloadString(request, 'runLineageId'), payloadPositiveInteger(request, 'ordinal'),
        payloadPositiveInteger(request, 'firstSequence'),
        payloadPositiveInteger(request, 'lastSequence'),
        payloadPositiveInteger(request, 'eventCount'),
        payloadStringArray(request, 'eventDigests', { requireOne: true, digest: true }),
        payloadString(request, 'eventManifestDigest'), payloadString(request, 'metadataDigest'),
      ],
    );
  };

  return {
    name: 'ml',
    ownedActions: Object.values(ML_ACTION_TYPES),
    materializers: {
      [ML_ACTION_TYPES.authorizePromotion]: promotionMaterializer,
    },
    effects: {
      [ML_ACTION_TYPES.registerAggregateReference]: registerAggregateReference,
      [ML_ACTION_TYPES.registerRunLineage]: registerRunLineage,
      [ML_ACTION_TYPES.registerMetricDefinition]: registerMetricDefinition,
      [ML_ACTION_TYPES.registerMetricSegment]: registerMetricSegment,
      [ML_ACTION_TYPES.authorizeMetricStream]: authorize,
      [ML_ACTION_TYPES.appendMetricEvent]: append,
      [ML_ACTION_TYPES.authorizePromotion]: authorizePromotion,
    },
    preconditions: {
      [ML_ACTION_TYPES.registerAggregateReference]: registryPrecondition(validateAggregateReferencePayload),
      [ML_ACTION_TYPES.registerRunLineage]: registryPrecondition(validateRunLineagePayload),
      [ML_ACTION_TYPES.registerMetricDefinition]: registryPrecondition(validateMetricDefinitionPayload),
      [ML_ACTION_TYPES.registerMetricSegment]: registryPrecondition(validateMetricSegmentPayload),
      [ML_ACTION_TYPES.authorizeMetricStream]: authorizePrecondition,
      [ML_ACTION_TYPES.appendMetricEvent]: appendPrecondition,
      [ML_ACTION_TYPES.authorizePromotion]: promotionPrecondition,
    },
  };
}
