import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { identityLabel, identityLine } from '../../lib/auth/identity-label';
import { IdentityBar } from './identity-bar';

const SUBJECT = '6f1c2b4e-9d3a-4c1e-8f2b-0a9b8c7d6e5f';
const ORGANIZATION = '01900000-0000-7000-8000-000000000002';
const ASSIGNMENT = '01900000-0000-7000-8000-000000000001';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const context = {
  actingRoleId: ASSIGNMENT,
  organizationId: ORGANIZATION,
  maxClassification: 'internal' as const,
};
const ids = [
  { label: 'Sign-in subject', value: SUBJECT },
  { label: 'Organization id', value: ORGANIZATION },
  { label: 'Role assignment id', value: ASSIGNMENT },
];

function render(line: ReturnType<typeof identityLine>): string {
  return renderToStaticMarkup(createElement(IdentityBar, { line, ids, ceiling: 'internal' }));
}

/** The markup outside the folded Details: what a person sees without opening anything. */
function visible(html: string): string {
  const fold = html.indexOf('<details');
  return fold < 0 ? html : html.slice(0, fold);
}

describe('the header says who is signed in, in words', () => {
  const label = identityLabel(SUBJECT, 'Kevin Sullivan', {
    personId: 'person-1',
    organizations: [
      {
        organizationId: ORGANIZATION,
        legalName: 'Véracier SA',
        clearance: 'internal',
        assignments: [{ assignmentId: ASSIGNMENT, roleId: 'quality_engineer', validTo: null }],
        refused: null,
      },
    ],
  });

  it('names the person, role, organization and what they can see, with no id in view', () => {
    const html = render(identityLine(label, context));
    const shown = visible(html);
    expect(shown).toContain('Kevin Sullivan');
    expect(shown).toContain('Quality engineer');
    expect(shown).toContain('Véracier SA');
    expect(shown).toContain('Sees up to Company');
    expect(shown).not.toMatch(UUID);
    // The ids are still there for whoever opens Details.
    expect(html.slice(html.indexOf('<details'))).toContain(SUBJECT);
    expect(html.slice(html.indexOf('<details'))).toContain(ASSIGNMENT);
  });

  it('falls back to words, never ids, when no label names this context', () => {
    const shown = visible(render(identityLine(undefined, context)));
    expect(shown).toContain('Signed in');
    expect(shown).toContain('Your role');
    expect(shown).toContain('Your organization');
    expect(shown).not.toMatch(UUID);
  });

  it('does not name another context’s role or organization', () => {
    const other = { ...context, actingRoleId: '01900000-0000-7000-8000-0000000000ff' };
    const line = identityLine(label, other);
    expect(line.role).toBe('Your role');
    expect(line.organization).toBe('Véracier SA');
  });
});
