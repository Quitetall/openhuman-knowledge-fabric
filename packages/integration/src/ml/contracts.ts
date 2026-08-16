import type { ActionEffect, ActionMaterializer, PreconditionCheck } from '@kf/actions';
import type { JsonValue } from '@kf/canonicalization';
import type {
  AggregateReference,
  MetricSegment,
  MetricValueKind,
  MlPromotionAuthorityKind,
  MlPromotionRiskTier,
  ProvisionalMetricEvent,
} from '@kf/ml-registry';

export const ML_ACTION_TYPES = {
  registerAggregateReference: 'register_ml_aggregate_reference',
  registerRunLineage: 'register_ml_run_lineage',
  registerMetricDefinition: 'register_ml_metric_definition',
  registerMetricSegment: 'register_ml_metric_segment',
  authorizeMetricStream: 'authorize_ml_metric_stream',
  appendMetricEvent: 'append_ml_metric_event',
  authorizePromotion: 'authorize_ml_promotion',
} as const;

export type MlActionType = (typeof ML_ACTION_TYPES)[keyof typeof ML_ACTION_TYPES];

export interface MlActionIntent {
  readonly actionType: MlActionType;
  /** ML actions always target exactly their owning organization object. */
  readonly targetId: string;
  /** Complete mutation semantics recorded verbatim in core.action.parameters. */
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface MlActionAtoms {
  readonly name: 'ml';
  readonly ownedActions: readonly MlActionType[];
  readonly materializers: Readonly<Partial<Record<MlActionType, ActionMaterializer>>>;
  readonly effects: Readonly<Record<MlActionType, ActionEffect>>;
  readonly preconditions: Readonly<Record<MlActionType, PreconditionCheck>>;
}

export type { MlPromotionAuthorityKind, MlPromotionRiskTier } from '@kf/ml-registry';

export interface PromotionAuthorizationInput {
  readonly aliasId: string;
  readonly candidateRefId: string;
  readonly runSealId: string;
  readonly policyRefId: string;
  /** Descriptive only; authorization never branches on this claim without a governed binding. */
  readonly riskTier: MlPromotionRiskTier;
  readonly authorityKind: MlPromotionAuthorityKind;
  readonly validUntil?: string;
}

export interface MlPromotionActionIntent {
  readonly actionType: typeof ML_ACTION_TYPES.authorizePromotion;
  /** Creation action: caller cannot select or reuse a decision target. */
  readonly targetIds: readonly [];
  readonly parameters: Readonly<Record<string, JsonValue>>;
}

export interface MetricStreamAuthorizationInput {
  readonly organizationId: string;
  readonly authorizedActorId: string;
  readonly authorizedRoleId: string;
  readonly runLineageId: string;
  readonly metricDefinitionId: string;
  readonly metricPolicyRefId: string;
}

export interface MetricEventAppendInput {
  readonly organizationId: string;
  readonly runLineageId: string;
  readonly metricDefinitionId: string;
  readonly event: ProvisionalMetricEvent;
}

export interface AggregateReferenceRegistrationInput {
  readonly organizationId: string;
  /** Internal relational identity; this does not allocate a governed enterprise identifier. */
  readonly referenceId: string;
  readonly reference: AggregateReference;
}

export interface RunLineageRegistrationInput {
  readonly organizationId: string;
  readonly lineageId: string;
  readonly runRefId: string;
  readonly codeRefId: string;
  readonly recipeRefId: string;
  readonly environmentRefId: string;
  readonly metricPolicyRefId: string;
  readonly inputRefIds: readonly string[];
  readonly outputRefIds: readonly string[];
  readonly parentModelRefIds: readonly string[];
  readonly lineageDigest: string;
}

export interface MetricDefinitionRegistrationInput {
  readonly organizationId: string;
  readonly definitionId: string;
  readonly definitionRefId: string;
  readonly metricId: string;
  readonly valueKind: MetricValueKind;
  readonly unitId: string | null;
  readonly allowedEnumIds: readonly string[];
}

export interface MetricSegmentRegistrationInput {
  readonly organizationId: string;
  readonly segmentId: string;
  readonly segmentRefId: string;
  readonly runLineageId: string;
  readonly segment: MetricSegment;
}
