import { digest } from '@kf/canonicalization';
import type {
  CompleteRunLineage,
  MetricWriteAuthorizationClaim,
  MetricWriteAuthorizationClaimInput,
  RunLineageInput,
} from './contracts.js';
import {
  assertExactKeys,
  checkedAggregate,
  checkedAggregates,
  checkedOrganizationId,
  checkedTimestamp,
  reject,
  requireOneOrganization,
} from './validation.js';

/** Build a complete, deeply immutable run-lineage record. */
export function createRunLineage(input: RunLineageInput): CompleteRunLineage {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    reject('run lineage must be an object');
  }
  assertExactKeys(
    input,
    ['run', 'code', 'recipe', 'environment', 'metricPolicy', 'inputs', 'outputs', 'parentModels'],
    'run lineage',
  );
  const run = checkedAggregate(input.run, 'run', ['run']);
  const code = checkedAggregate(input.code, 'code', ['code']);
  const recipe = checkedAggregate(input.recipe, 'recipe', ['recipe']);
  const environment = checkedAggregate(input.environment, 'environment', ['environment']);
  const metricPolicy = checkedAggregate(input.metricPolicy, 'metricPolicy', ['metric_policy']);
  const inputs = checkedAggregates(input.inputs, 'inputs', true, ['input']);
  const outputs = checkedAggregates(input.outputs, 'outputs', true, ['output', 'candidate']);
  const parentModels = checkedAggregates(input.parentModels, 'parentModels', false, [
    'parent_model',
  ]);
  requireOneOrganization(
    run.organizationId,
    [code, recipe, environment, metricPolicy, ...inputs, ...outputs, ...parentModels],
    'run lineage references',
  );
  return Object.freeze({
    schemaVersion: 'kf.ml.run-lineage.v1',
    run,
    code,
    recipe,
    environment,
    metricPolicy,
    inputs,
    outputs,
    parentModels,
  });
}

/** Derive exact metric-stream authority bytes; callers cannot choose persisted digest. */
export function createMetricWriteAuthorizationClaim(
  input: MetricWriteAuthorizationClaimInput,
): MetricWriteAuthorizationClaim {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    reject('metric write authorization must be an object');
  }
  assertExactKeys(
    input,
    [
      'organizationId',
      'actionId',
      'actorId',
      'actingRoleId',
      'runLineageId',
      'metricDefinitionId',
      'metricPolicyRefId',
      'authorizedAt',
    ],
    'metric write authorization',
  );
  const unsigned = Object.freeze({
    schemaVersion: 'kf.ml.metric-write-authorization.v2' as const,
    actionId: checkedOrganizationId(input.actionId, 'actionId'),
    organizationId: checkedOrganizationId(input.organizationId, 'organizationId'),
    actorId: checkedOrganizationId(input.actorId, 'actorId'),
    actingRoleId: checkedOrganizationId(input.actingRoleId, 'actingRoleId'),
    runLineageId: checkedOrganizationId(input.runLineageId, 'runLineageId'),
    metricDefinitionId: checkedOrganizationId(input.metricDefinitionId, 'metricDefinitionId'),
    metricPolicyRefId: checkedOrganizationId(input.metricPolicyRefId, 'metricPolicyRefId'),
    authorizedAt: checkedTimestamp(input.authorizedAt, 'authorizedAt'),
  });
  return Object.freeze({ ...unsigned, authorizationDigest: digest(unsigned) });
}
