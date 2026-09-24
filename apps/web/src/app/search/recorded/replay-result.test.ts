import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UNVERIFIED_LABEL } from '../../../lib/api/verification.js';
import { ReplayResult } from './replay-result.js';

describe('a replay shows what the original ceiling withheld', () => {
  it('lists the withheld records and says the demand count names nobody', () => {
    const html = renderToStaticMarkup(
      createElement(ReplayResult, {
        state: {
          status: 'replayed',
          replay: {
            recordedQueryId: 'q-1',
            askerCeiling: 'internal',
            counted: 1,
            withheld: [
              {
                objectId: 'document-9',
                objectType: 'decision_record',
                title: 'Second source pricing',
                lifecycleState: 'draft',
                classification: 'restricted',
                rank: 0.4,
                matchedBy: 'full_text',
                verification: { verified: false, label: UNVERIFIED_LABEL },
              },
            ],
          },
        },
      }),
    );
    expect(html).toContain('Second source pricing');
    expect(html).toContain('1 record matching this query was withheld');
    expect(html).toContain('never who');
  });

  it('says so when nothing was withheld, and shows a refusal as one', () => {
    expect(
      renderToStaticMarkup(
        createElement(ReplayResult, {
          state: {
            status: 'replayed',
            replay: { recordedQueryId: 'q-1', askerCeiling: 'internal', counted: 0, withheld: [] },
          },
        }),
      ),
    ).toContain('Nothing matching this query was withheld');
    expect(
      renderToStaticMarkup(
        createElement(ReplayResult, {
          state: {
            status: 'refused',
            message: 'This query has expired or is not yours to replay.',
          },
        }),
      ),
    ).toContain('role="alert"');
    expect(renderToStaticMarkup(createElement(ReplayResult, { state: { status: 'idle' } }))).toBe(
      '',
    );
  });
});
