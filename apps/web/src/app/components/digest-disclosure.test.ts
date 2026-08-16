import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DigestDisclosure } from './digest-disclosure.js';

describe('DigestDisclosure', () => {
  it('uses a native disclosure with both the comparison label and exact digest', () => {
    const digest = '0123456789abcdef'.repeat(4);

    const html = renderToStaticMarkup(
      createElement(DigestDisclosure, { digest, label: 'event digest' }),
    );

    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('0123456789ab…');
    expect(html).toContain('Show exact event digest');
    expect(html).toContain(digest);
    expect(html).not.toContain('title=');
  });
});
