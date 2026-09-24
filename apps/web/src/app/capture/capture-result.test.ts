import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UNVERIFIED_LABEL } from '../../lib/api/verification';
import { CaptureResult } from './capture-result';

const outcome = {
  observationId: '019ff405-2ec7-736e-898a-1f5687a80a48',
  actionId: 'act-1',
  replayed: false,
  gestureId: 'g-1',
  lifecycleState: 'captured',
  verification: { verified: false, label: UNVERIFIED_LABEL },
};

describe('CaptureResult', () => {
  it('states the verification label on the result of a capture', () => {
    const html = renderToStaticMarkup(
      createElement(CaptureResult, {
        state: { status: 'recorded', gestureId: 'g-2', outcome },
      }),
    );
    expect(html).toContain('Recorded.');
    expect(html).toContain(UNVERIFIED_LABEL);
    expect(html).toContain('data-verified="false"');
    expect(html).toContain(`/objects/${outcome.observationId}`);
  });

  it('says a replayed gesture was already recorded', () => {
    const html = renderToStaticMarkup(
      createElement(CaptureResult, {
        state: { status: 'recorded', gestureId: 'g-2', outcome: { ...outcome, replayed: true } },
      }),
    );
    expect(html).toContain('Already recorded');
    expect(html).toContain(UNVERIFIED_LABEL);
  });

  it('says a refused capture was not recorded', () => {
    const html = renderToStaticMarkup(
      createElement(CaptureResult, {
        state: { status: 'refused', gestureId: 'g-1', message: 'no live assignment' },
      }),
    );
    expect(html).toContain('Not recorded: no live assignment');
  });
});
