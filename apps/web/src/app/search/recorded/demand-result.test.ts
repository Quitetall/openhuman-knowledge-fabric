import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UNVERIFIED_LABEL } from '../../../lib/api/verification.js';
import { DemandResult } from './demand-result.js';

describe('a demand replay shows the aggregate and nothing about any query', () => {
  it('lists each record with its distinct-person count and its verification label', () => {
    const html = renderToStaticMarkup(
      createElement(DemandResult, {
        state: {
          status: 'replayed',
          replay: {
            replayed: 3,
            truncated: false,
            counted: 2,
            records: [
              {
                objectId: 'document-9',
                objectType: 'decision_record',
                title: 'Second source pricing',
                classification: 'restricted',
                distinctPersonCount: 2,
                verification: { verified: false, label: UNVERIFIED_LABEL },
              },
            ],
          },
        },
      }),
    );
    expect(html).toContain('Replayed 3 recorded queries asked below your clearance');
    expect(html).toContain('Second source pricing');
    expect(html).toContain('wanted by 2 people');
    expect(html).toContain('not evidence that nobody needs access');
    // KF-SAS-RQ-229: labelled like every other place a record appears.
    expect(html).toContain(UNVERIFIED_LABEL);
    expect(html).toContain('data-verified="false"');
  });

  it('shows nothing before the button is pressed', () => {
    expect(renderToStaticMarkup(createElement(DemandResult, { state: { status: 'idle' } }))).toBe(
      '',
    );
  });
});
