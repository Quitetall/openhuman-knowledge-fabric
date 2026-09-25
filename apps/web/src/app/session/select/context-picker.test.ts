import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../lib/api/client.js';
import {
  assignmentsFailure,
  ceilingOptions,
  defaultCeiling,
  preselectedAssignment,
  roleName,
  validUntil,
} from './context-picker.js';

const ORG = '01a0d661-0aae-71e9-954f-fb10fb1222db';
const A = {
  assignmentId: 'f03a6a9e-a2e4-4c23-94d9-d8db1d08f0d8',
  roleId: 'project_owner',
  validTo: null,
};
const B = {
  assignmentId: '01a0d661-8d80-73fb-af78-90e3defb319e',
  roleId: 'work_order_manager',
  validTo: '2027-09-25T02:24:58.089Z',
};

describe('context picker', () => {
  it('names roles and end dates in words', () => {
    expect(roleName('work_order_manager')).toBe('Work order manager');
    expect(roleName('performer')).toBe('Performer');
    expect(validUntil(null)).toBe('no end date');
    expect(validUntil('2027-09-25T02:24:58.089Z')).toBe('valid until 2027-09-25 (UTC)');
  });

  it('offers only ceilings at or below the clearance', () => {
    expect(ceilingOptions('public')).toEqual(['public']);
    expect(ceilingOptions('internal')).toEqual(['public', 'internal']);
    expect(ceilingOptions('restricted')).toEqual([
      'public',
      'internal',
      'confidential',
      'restricted',
    ]);
  });

  it('defaults the ceiling to the clearance, or to the one in use if still allowed', () => {
    expect(defaultCeiling('confidential', undefined, ORG)).toBe('confidential');
    const current = {
      actingRoleId: A.assignmentId,
      organizationId: ORG,
      maxClassification: 'public' as const,
    };
    expect(defaultCeiling('confidential', current, ORG)).toBe('public');
    expect(defaultCeiling('internal', { ...current, maxClassification: 'restricted' }, ORG)).toBe(
      'internal',
    );
    expect(defaultCeiling('confidential', current, '01a0d661-0000-7000-8000-000000000000')).toBe(
      'confidential',
    );
  });

  it('preselects the only assignment, else the one in use, else none', () => {
    expect(preselectedAssignment([A], undefined)).toBe(A.assignmentId);
    expect(preselectedAssignment([A, B], undefined)).toBeUndefined();
    expect(
      preselectedAssignment([A, B], {
        actingRoleId: B.assignmentId,
        organizationId: ORG,
        maxClassification: 'internal',
      }),
    ).toBe(B.assignmentId);
  });

  it('explains why assignments could not be listed', () => {
    expect(assignmentsFailure(new ApiError(422, 'no_live_assignment', 'x', undefined))).toMatch(
      /no live role assignment/,
    );
    expect(assignmentsFailure(new ApiError(422, 'no_clearance', 'x', undefined))).toMatch(
      /No clearance/,
    );
    expect(assignmentsFailure(new ApiError(401, 'unidentified', 'x', undefined))).toMatch(
      /sign in again/,
    );
    expect(assignmentsFailure(new ApiError(503, 'unavailable', 'x', undefined))).toMatch(
      /could not list/,
    );
    expect(assignmentsFailure(new TypeError('fetch failed'))).toMatch(/could not list/);
  });
});
