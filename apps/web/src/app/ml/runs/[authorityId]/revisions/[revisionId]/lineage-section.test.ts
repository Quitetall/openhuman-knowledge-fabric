import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LineageSection } from './lineage-section.js';
import type { AggregateReference, RunProjection } from './run-projection.js';

function reference(kind: string, fill: string): AggregateReference {
  return {
    kind,
    authorityId: `${kind}-authority`,
    revisionId: `${kind}-revision`,
    sha256: fill.repeat(64),
    classificationId: 'internal',
    policyId: 'policy-1',
  };
}

const lineageDigest = 'a'.repeat(64);
const codeDigest = 'b'.repeat(64);
const lineage: RunProjection['lineage'] = {
  lineageDigest,
  recordedAt: '2026-08-15T12:00:00.000Z',
  code: reference('code', 'b'),
  recipe: reference('recipe', 'c'),
  environment: reference('environment', 'd'),
  metricPolicy: reference('metric-policy', 'e'),
  members: {
    items: [],
    page: { limit: 50, afterMember: null, nextAfterMember: null },
  },
};

describe('LineageSection', () => {
  it('discloses exact lineage and reference digests through native controls', () => {
    const html = renderToStaticMarkup(
      createElement(LineageSection, { lineage, nextPageHref: undefined }),
    );

    expect(html).toContain('Show exact lineage digest');
    expect(html).toContain('Show exact code SHA-256');
    expect(html).toContain(lineageDigest);
    expect(html).toContain(codeDigest);
    expect(html).not.toContain(`title="${lineageDigest}"`);
    expect(html).not.toContain(`title="${codeDigest}"`);
  });
});
