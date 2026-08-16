import { digest } from '@kf/canonicalization';
import type { MetricSegment, MetricSegmentInput } from './contracts.js';
import {
  SHA256,
  assertExactKeys,
  checkedAggregate,
  checkedPositiveInteger,
  reject,
  requireOneOrganization,
} from './validation.js';

export const METRIC_SEGMENT_INPUT_KEYS = [
  'segment',
  'run',
  'ordinal',
  'firstSequence',
  'lastSequence',
  'eventCount',
  'eventDigests',
] as const;

/** Bind one immutable, content-addressed metric segment to its run and sequence range. */
export function createMetricSegment(input: MetricSegmentInput): MetricSegment {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    reject('metric segment must be an object');
  }
  assertExactKeys(input, METRIC_SEGMENT_INPUT_KEYS, 'metric segment');
  const ordinal = checkedPositiveInteger(input.ordinal, 'metric segment.ordinal');
  const firstSequence = checkedPositiveInteger(input.firstSequence, 'metric segment.firstSequence');
  const lastSequence = checkedPositiveInteger(input.lastSequence, 'metric segment.lastSequence');
  const eventCount = checkedPositiveInteger(input.eventCount, 'metric segment.eventCount');
  if (lastSequence < firstSequence || eventCount !== lastSequence - firstSequence + 1) {
    reject('metric segment must describe one complete contiguous sequence range');
  }
  if (
    !Array.isArray(input.eventDigests) ||
    input.eventDigests.length !== eventCount ||
    input.eventDigests.some((entry) => typeof entry !== 'string' || !SHA256.test(entry)) ||
    new Set(input.eventDigests).size !== input.eventDigests.length
  ) {
    reject('metric segment event digest manifest must contain one unique SHA-256 per sequence');
  }
  const segment = checkedAggregate(input.segment, 'metric segment.segment', ['segment']);
  const run = checkedAggregate(input.run, 'metric segment.run', ['run']);
  requireOneOrganization(run.organizationId, [segment], 'metric segment references');
  const eventDigests = Object.freeze([...input.eventDigests]);
  const unsigned = Object.freeze({
    schemaVersion: 'kf.ml.metric-segment.v2' as const,
    segment,
    run,
    ordinal,
    firstSequence,
    lastSequence,
    eventCount,
    eventDigests,
    eventManifestDigest: digest(eventDigests),
  });
  return Object.freeze({ ...unsigned, metadataDigest: digest(unsigned) });
}
