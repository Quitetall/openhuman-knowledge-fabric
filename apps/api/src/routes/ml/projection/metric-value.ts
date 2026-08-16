import type { MetricValue } from '@kf/ml-registry';

import type { MetricValueColumns } from './contracts.js';
import { invalid } from './error.js';
import { decodeGovernedId, decodeIsoTimestamp, decodeMetricValueKind } from './scalars.js';

export function decodeMetricValue(columns: MetricValueColumns, field: string): MetricValue {
  const valueKind = decodeMetricValueKind(columns.valueKind, `${field}.kind`);
  if (valueKind === 'number') {
    if (
      typeof columns.numericValue !== 'number' ||
      !Number.isFinite(columns.numericValue) ||
      columns.enumValue !== null ||
      columns.timestampValue !== null
    ) {
      invalid(field);
    }
    return { kind: 'number', number: columns.numericValue };
  }
  if (valueKind === 'safe_enum') {
    if (columns.numericValue !== null || columns.timestampValue !== null) invalid(field);
    return {
      kind: 'safe_enum',
      enumId: decodeGovernedId(columns.enumValue, `${field}.enumId`),
    };
  }
  if (columns.numericValue !== null || columns.enumValue !== null) invalid(field);
  return {
    kind: 'timestamp',
    timestamp: decodeIsoTimestamp(columns.timestampValue, `${field}.timestamp`),
  };
}
