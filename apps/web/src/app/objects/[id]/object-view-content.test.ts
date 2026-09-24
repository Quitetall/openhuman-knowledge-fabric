import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UNVERIFIED_LABEL as DOMAIN_UNVERIFIED_LABEL } from '@kf/domain';
import { parseObjectView } from '../../../lib/api/object-views.js';
import { UNVERIFIED_LABEL } from '../../../lib/api/verification.js';
import { ObjectViewContent } from './object-view-content.js';

/**
 * The Object View page says which records nobody has checked (KF-SAS-RQ-229): the subject and
 * each related record, with the master record renderer's words and class.
 */

const SUBJECT = '01a00000-0000-7000-8000-000000000001';
const RELATED = '01a00000-0000-7000-8000-000000000002';
const verified = {
  verified: true,
  basis: 'reviewed_individually',
  verifiedAt: '2026-09-20T00:00:00.000Z',
  verifiedBy: 'reviewer',
  label: 'verified reviewed individually by reviewer at 2026-09-20T00:00:00.000Z',
};
const member = (objectId: string, title: string, verification?: unknown) => ({
  objectId,
  objectType: 'decision_record',
  classification: 'internal',
  contentDigest: 'd'.repeat(64),
  itemState: 'included',
  lifecycleState: 'draft',
  title,
  ...(verification === undefined ? {} : { verification }),
});

function body(subjectVerification: unknown, relatedVerification: unknown) {
  return {
    result: {
      projectionDigest: 'p'.repeat(64),
      source: { corpusDigest: 'c'.repeat(64) },
      sections: [
        { id: 'subject', members: [member(SUBJECT, 'The subject', subjectVerification)] },
        { id: 'relationships', members: [member(RELATED, 'Related', relatedVerification)] },
        { id: 'other', members: [] },
      ],
      edges: [{ sourceId: SUBJECT, targetId: RELATED, relationType: 'supersedes' }],
    },
    facets: { history: { events: [] }, availableActions: [] },
  };
}

const render = (value: unknown) =>
  renderToStaticMarkup(createElement(ObjectViewContent, { view: parseObjectView(value) }));

describe('Object View verification', () => {
  it('shows an unverified subject as UNVERIFIED, with the master record class', () => {
    const html = render(body({ verified: false, label: UNVERIFIED_LABEL }, verified));
    expect(html).toContain(
      `<p class="kf-verification unverified" data-verified="false">${UNVERIFIED_LABEL}</p>`,
    );
    expect(html).toContain('verified reviewed individually by reviewer');
  });

  it('labels an unverified related record beside its link', () => {
    const html = render(body(verified, { verified: false, label: UNVERIFIED_LABEL }));
    const related = html.slice(html.indexOf(`/objects/${RELATED}`));
    expect(related).toContain(`class="kf-verification unverified"`);
    expect(html.match(/class="kf-verification unverified"/g)).toHaveLength(1);
  });

  it('fails closed: a member with no verification, or a claim without its facts, is unverified', () => {
    const html = render(body(undefined, { verified: true, label: 'verified trust me' }));
    expect(html.match(/class="kf-verification unverified"/g)).toHaveLength(2);
    expect(html).not.toContain('trust me');
  });

  it('uses the same unverified words as the master record', () => {
    expect(UNVERIFIED_LABEL).toBe(DOMAIN_UNVERIFIED_LABEL);
  });
});
