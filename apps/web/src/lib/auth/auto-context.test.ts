import { describe, expect, it } from 'vitest';
import type { SessionContextOrganization, SessionContexts } from '../api/session-contexts';
import { decideContext } from './auto-context';

const ORG_A = '01900000-0000-7000-8000-00000000000a';
const ORG_B = '01900000-0000-7000-8000-00000000000b';

function organization(
  id: string,
  assignments: readonly string[],
  extra: Partial<SessionContextOrganization> = {},
): SessionContextOrganization {
  return {
    organizationId: id,
    legalName: `Org ${id.slice(-1)}`,
    clearance: 'confidential',
    assignments: assignments.map((assignmentId) => ({
      assignmentId,
      roleId: 'quality_engineer',
      validTo: null,
    })),
    refused: null,
    ...extra,
  };
}

function contexts(...organizations: SessionContextOrganization[]): SessionContexts {
  return { personId: 'person-1', organizations };
}

describe('whether a person who has just signed in is asked to choose a context', () => {
  it('proposes the only assignment, at the person’s full clearance', () => {
    expect(decideContext(contexts(organization(ORG_A, ['assignment-1'])))).toEqual({
      kind: 'auto',
      context: {
        actingRoleId: 'assignment-1',
        organizationId: ORG_A,
        maxClassification: 'confidential',
      },
    });
  });

  it('asks when there is nothing to choose from', () => {
    expect(decideContext(contexts())).toEqual({ kind: 'choose' });
  });

  it('asks when one organization holds two assignments', () => {
    expect(decideContext(contexts(organization(ORG_A, ['assignment-1', 'assignment-2'])))).toEqual({
      kind: 'choose',
    });
  });

  it('asks when two organizations hold one assignment each', () => {
    expect(
      decideContext(
        contexts(organization(ORG_A, ['assignment-1']), organization(ORG_B, ['assignment-2'])),
      ),
    ).toEqual({ kind: 'choose' });
  });

  it('asks when the one organization could not be described', () => {
    expect(
      decideContext(
        contexts(
          organization(ORG_A, [], { clearance: null, refused: 'classification_not_granted' }),
        ),
      ),
    ).toEqual({ kind: 'choose' });
  });

  it('asks when an assignment elsewhere could not be described, even with one listed here', () => {
    expect(
      decideContext(
        contexts(
          organization(ORG_A, ['assignment-1']),
          organization(ORG_B, [], { clearance: null, refused: 'role_not_held' }),
        ),
      ),
    ).toEqual({ kind: 'choose' });
  });
});
