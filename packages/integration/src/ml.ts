/**
 * Typed-action boundary for the privacy-minimal ML metric registry.
 *
 * Public interface stays concentrated here. Private modules under ./ml/ contain payload
 * validation, authority checks, intent builders, and dispatcher composition.
 */

export {
  ML_ACTION_TYPES,
  type MetricEventAppendInput,
  type AggregateReferenceRegistrationInput,
  type MetricDefinitionRegistrationInput,
  type MetricSegmentRegistrationInput,
  type MetricStreamAuthorizationInput,
  type MlActionAtoms,
  type MlActionIntent,
  type MlActionType,
  type MlPromotionActionIntent,
  type MlPromotionAuthorityKind,
  type MlPromotionRiskTier,
  type PromotionAuthorizationInput,
  type RunLineageRegistrationInput,
} from './ml/contracts.js';

export {
  actionForMetricEventAppend,
  actionForAggregateReferenceRegistration,
  actionForMetricDefinitionRegistration,
  actionForMetricSegmentRegistration,
  actionForRunLineageRegistration,
  actionForMetricStreamAuthorization,
  actionForPromotionAuthorization,
  metricEventActionIdempotencyKey,
  mlRegistryActionIdempotencyKey,
} from './ml/builders.js';

export { createMlActionAtoms } from './ml/action-atoms.js';
