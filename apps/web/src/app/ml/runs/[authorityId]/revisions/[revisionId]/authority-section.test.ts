import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthoritySection } from './authority-section.js';
import type { RunProjection } from './run-projection.js';

const SEAL_DIGEST = 'a'.repeat(64);

const seal: NonNullable<RunProjection['seal']> = {
  lineageDigest: 'b'.repeat(64),
  segmentManifestDigest: 'c'.repeat(64),
  eventCount: '12',
  sealedAt: '2026-08-15T12:00:00.000Z',
  signingKeyId: 'key-1',
  sealDigest: SEAL_DIGEST,
  recordedAt: '2026-08-15T12:00:01.000Z',
};

const emptyPromotions: RunProjection['promotions'] = {
  receipts: [],
  page: { limit: 50, afterReceiptDigest: null, nextAfterReceiptDigest: null },
};

describe('AuthoritySection', () => {
  it('makes the exact seal digest available without pointer-only title text', () => {
    const html = renderToStaticMarkup(
      createElement(AuthoritySection, {
        seal,
        promotions: emptyPromotions,
        nextPromotionPageHref: undefined,
      }),
    );

    expect(html).toContain('Show exact seal digest');
    expect(html).toContain(SEAL_DIGEST);
    expect(html).not.toContain(`title="${SEAL_DIGEST}"`);
  });

  it('does not interpret an empty caller-scoped page as global absence', () => {
    const html = renderToStaticMarkup(
      createElement(AuthoritySection, {
        seal: null,
        promotions: emptyPromotions,
        nextPromotionPageHref: undefined,
      }),
    );

    expect(html).toContain('caller-scoped page');
    expect(html).toContain('cannot prove');
    expect(html).not.toContain('No promotion receipt.</p>');
  });
});
