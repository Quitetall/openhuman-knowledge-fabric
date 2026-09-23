import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReadinessPanel } from './readiness-panel';

const ORG = '01930000-0000-7000-8000-00000000abcd';
const partition = {
  ready: false,
  checks: [
    {
      id: 'search_index',
      scope: 'service' as const,
      status: 'degraded' as const,
      detail: `3 record(s) are not indexed, in 1 organization(s): ${ORG} (3).`,
      measured: { organizations: 1, behind: 1 },
    },
  ],
};

describe('ReadinessPanel', () => {
  it('shows a signed-out visitor each verdict but nothing a check measured', () => {
    const html = renderToStaticMarkup(
      createElement(ReadinessPanel, {
        title: 'Measured service readiness',
        partition,
        readyLabel: 'Ready.',
        blockedLabel: 'Not ready.',
        redacted: true,
      }),
    );
    expect(html).toContain('search_index');
    expect(html).toContain('degraded');
    expect(html).not.toContain(ORG);
    expect(html).not.toContain('organizations=1');
  });

  it('shows a signed-in operator the full detail', () => {
    const html = renderToStaticMarkup(
      createElement(ReadinessPanel, {
        title: 'Measured service readiness',
        partition,
        readyLabel: 'Ready.',
        blockedLabel: 'Not ready.',
      }),
    );
    expect(html).toContain(ORG);
  });
});
