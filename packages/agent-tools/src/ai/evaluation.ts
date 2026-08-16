import type { AiEvaluationResult } from './types.js';
import { exactKeys, record, requireNonempty } from './primitives.js';

const METRIC_FIELDS = [
  'retrievalAccuracy',
  'referenceResolution',
  'structureTable',
  'graphOperations',
  'hallucination',
  'provenanceRetention',
  'leakage',
] as const;

export function validateAiEvaluationResult(value: unknown): AiEvaluationResult {
  const result = record(value, 'AI evaluation result');
  exactKeys(
    result,
    [
      'suiteId',
      'basisId',
      'providerId',
      'modelId',
      'policyId',
      'tokenizer',
      'evaluatedAt',
      ...METRIC_FIELDS,
      'tokensPerSemanticFact',
    ],
    'AI evaluation result',
  );
  const evaluatedAt = requireNonempty(result['evaluatedAt'], 'evaluatedAt');
  if (!Number.isFinite(Date.parse(evaluatedAt))) throw new Error('evaluatedAt must be an instant');
  const metrics = Object.fromEntries(
    METRIC_FIELDS.map((field) => [field, boundedMetric(result[field], field)]),
  ) as Pick<AiEvaluationResult, (typeof METRIC_FIELDS)[number]>;
  const tokensPerSemanticFact = result['tokensPerSemanticFact'];
  if (
    typeof tokensPerSemanticFact !== 'number' ||
    !Number.isFinite(tokensPerSemanticFact) ||
    tokensPerSemanticFact <= 0
  ) {
    throw new Error('tokensPerSemanticFact must be positive');
  }
  return Object.freeze({
    suiteId: requireNonempty(result['suiteId'], 'suiteId'),
    basisId: requireNonempty(result['basisId'], 'basisId'),
    providerId: requireNonempty(result['providerId'], 'providerId'),
    modelId: requireNonempty(result['modelId'], 'modelId'),
    policyId: requireNonempty(result['policyId'], 'policyId'),
    tokenizer: requireNonempty(result['tokenizer'], 'tokenizer'),
    evaluatedAt,
    ...metrics,
    tokensPerSemanticFact,
  });
}

function boundedMetric(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return value;
}
