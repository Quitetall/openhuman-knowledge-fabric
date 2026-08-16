import { digest } from '@kf/canonicalization';
import type {
  MetricDefinition,
  MetricEventInput,
  MetricValue,
  ProvisionalMetricEvent,
} from './contracts.js';
import {
  GOVERNANCE_ID,
  assertExactKeys,
  checkedAggregate,
  checkedId,
  checkedTimestamp,
  reject,
  requireOneOrganization,
} from './validation.js';

const METRIC_DEFINITION_KEYS = [
  'reference',
  'metricId',
  'valueKind',
  'unitId',
  'allowedValues',
] as const;
const METRIC_EVENT_INPUT_KEYS = [
  'idempotencyKey',
  'run',
  'sequence',
  'recordedAt',
  'value',
] as const;

function checkedMetricDefinition(definition: MetricDefinition): MetricDefinition {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    reject('metric definition must be an object');
  }
  assertExactKeys(definition, METRIC_DEFINITION_KEYS, 'metric definition');
  const metricId = checkedId(definition.metricId, 'metric definition.metricId', GOVERNANCE_ID);
  if (!Array.isArray(definition.allowedValues)) {
    reject(`metric definition ${metricId} needs an allowed-values array`);
  }
  const allowedValues = definition.allowedValues.map((value, index) =>
    checkedId(value, `metric definition.allowedValues[${index}]`, GOVERNANCE_ID),
  );
  if (new Set(allowedValues).size !== allowedValues.length) {
    reject(`metric definition ${metricId} repeats an allowed enum value`);
  }

  let unitId: string | null;
  switch (definition.valueKind) {
    case 'number':
      if (definition.unitId === null) {
        reject(`numeric metric definition ${metricId} needs a unit ID`);
      }
      unitId = checkedId(definition.unitId, 'metric definition.unitId', GOVERNANCE_ID);
      if (allowedValues.length !== 0) {
        reject(`numeric metric definition ${metricId} cannot declare enum values`);
      }
      break;
    case 'safe_enum':
      if (definition.unitId !== null) {
        reject(`safe-enum metric definition ${metricId} cannot declare a unit`);
      }
      if (allowedValues.length === 0) {
        reject(`safe-enum metric definition ${metricId} needs allowed values`);
      }
      unitId = null;
      break;
    case 'timestamp':
      if (definition.unitId !== null || allowedValues.length !== 0) {
        reject(`timestamp metric definition ${metricId} cannot declare a unit or enum values`);
      }
      unitId = null;
      break;
    default:
      reject(`metric definition ${metricId} has an unsupported value kind`);
  }
  return Object.freeze({
    reference: checkedAggregate(definition.reference, 'metric definition.reference', [
      'metric_definition',
    ]),
    metricId,
    valueKind: definition.valueKind,
    unitId,
    allowedValues: Object.freeze(allowedValues),
  });
}

function checkedMetricValue(definition: MetricDefinition, value: MetricValue): MetricValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject('metric value must be a typed object');
  }
  if (definition.valueKind === 'number') {
    if (value.kind !== 'number') reject('numeric metric requires a number value');
    assertExactKeys(value, ['kind', 'number'], 'numeric metric value');
    if (!Number.isFinite(value.number)) reject('numeric metric value must be finite');
    return Object.freeze({ kind: 'number', number: value.number });
  }
  if (definition.valueKind === 'safe_enum') {
    if (value.kind !== 'safe_enum') reject('safe-enum metric requires an enum identifier');
    assertExactKeys(value, ['kind', 'enumId'], 'safe-enum metric value');
    const enumId = checkedId(value.enumId, 'safe-enum metric value.enumId', GOVERNANCE_ID);
    if (!definition.allowedValues.includes(enumId)) {
      reject(`enum identifier ${enumId} is not allowed for metric ${definition.metricId}`);
    }
    return Object.freeze({ kind: 'safe_enum', enumId });
  }
  if (value.kind !== 'timestamp') reject('timestamp metric requires a timestamp value');
  assertExactKeys(value, ['kind', 'timestamp'], 'timestamp metric value');
  return Object.freeze({
    kind: 'timestamp',
    timestamp: checkedTimestamp(value.timestamp, 'timestamp metric value.timestamp'),
  });
}

/** Append-only in-memory seam used by ingestion code before persistence. */
export class MetricEventJournal {
  readonly #byIdempotency = new Map<string, ProvisionalMetricEvent>();
  readonly #bySequence = new Map<string, ProvisionalMetricEvent>();
  readonly #events: ProvisionalMetricEvent[] = [];

  append(definitionInput: MetricDefinition, input: MetricEventInput): ProvisionalMetricEvent {
    const definition = checkedMetricDefinition(definitionInput);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      reject('metric event must be an object');
    }
    assertExactKeys(input, METRIC_EVENT_INPUT_KEYS, 'metric event');
    const idempotencyKey = checkedId(input.idempotencyKey, 'metric event.idempotencyKey');
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0) {
      reject('metric event.sequence must be a positive safe integer');
    }

    const run = checkedAggregate(input.run, 'metric event.run', ['run']);
    requireOneOrganization(run.organizationId, [definition.reference], 'metric event references');
    const unsigned = Object.freeze({
      schemaVersion: 'kf.ml.metric-event.v1' as const,
      status: 'provisional' as const,
      idempotencyKey,
      run,
      metricDefinition: definition.reference,
      metricId: definition.metricId,
      sequence: input.sequence,
      recordedAt: checkedTimestamp(input.recordedAt, 'metric event.recordedAt'),
      value: checkedMetricValue(definition, input.value),
    });
    const candidate = Object.freeze({ ...unsigned, eventDigest: digest(unsigned) });
    const runIdentity = digest(candidate.run);
    const key = `${runIdentity}\u0000${idempotencyKey}`;
    const existing = this.#byIdempotency.get(key);
    if (existing !== undefined) {
      if (existing.eventDigest !== candidate.eventDigest) {
        reject(`idempotency key ${idempotencyKey} was already used for a different event`);
      }
      return existing;
    }
    const sequenceKey = `${runIdentity}\u0000${String(candidate.sequence)}`;
    if (this.#bySequence.has(sequenceKey)) {
      reject(`sequence ${String(candidate.sequence)} already exists for this run`);
    }
    this.#byIdempotency.set(key, candidate);
    this.#bySequence.set(sequenceKey, candidate);
    this.#events.push(candidate);
    return candidate;
  }

  entries(): readonly ProvisionalMetricEvent[] {
    return Object.freeze([...this.#events]);
  }
}
