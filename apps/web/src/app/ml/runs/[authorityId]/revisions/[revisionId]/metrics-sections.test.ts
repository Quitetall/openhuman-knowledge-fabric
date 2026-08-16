import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetricsSections } from './metrics-sections.js';
import type { RunProjection } from './run-projection.js';

const EVENT_DIGEST = 'a'.repeat(64);
const SEGMENT_DIGEST = 'b'.repeat(64);

const metrics: RunProjection['metrics'] = {
  events: [
    {
      sequence: '1',
      recordedAt: '2026-08-15T12:00:00.000Z',
      status: 'provisional',
      metricId: 'loss',
      unitId: null,
      value: { kind: 'number', number: 0.25 },
      eventDigest: EVENT_DIGEST,
    },
  ],
  page: { limit: 50, afterSequence: '0', nextAfterSequence: null },
};

const segments: RunProjection['segments'] = {
  items: [
    {
      reference: {
        kind: 'metric_segment',
        authorityId: 'segment-1',
        revisionId: 'revision-1',
        sha256: 'c'.repeat(64),
        classificationId: 'internal',
        policyId: 'policy-1',
      },
      ordinal: 1,
      firstSequence: '1',
      lastSequence: '1',
      eventCount: '1',
      metadataDigest: SEGMENT_DIGEST,
    },
  ],
  page: { limit: 50, afterOrdinal: 0, nextAfterOrdinal: null },
};

describe('MetricsSections', () => {
  it('discloses exact event and segment digests through native controls', () => {
    const html = renderToStaticMarkup(
      createElement(MetricsSections, {
        metrics,
        segments,
        nextMetricPageHref: undefined,
        nextSegmentPageHref: undefined,
      }),
    );

    expect(html).toContain('Show exact event digest');
    expect(html).toContain('Show exact segment digest');
    expect(html).toContain(EVENT_DIGEST);
    expect(html).toContain(SEGMENT_DIGEST);
    expect(html).not.toContain(`title="${EVENT_DIGEST}"`);
    expect(html).not.toContain(`title="${SEGMENT_DIGEST}"`);
  });
});
