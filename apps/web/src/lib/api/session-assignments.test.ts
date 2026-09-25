import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';
import { getSessionAssignments, parseSessionAssignments } from './session-assignments.js';

const BODY = {
  organizationId: '01a0d661-0aae-71e9-954f-fb10fb1222db',
  personId: '01a0d661-0ab4-7f1b-bf8c-19d9780b243d',
  clearance: 'restricted',
  assignments: [
    {
      assignmentId: 'f03a6a9e-a2e4-4c23-94d9-d8db1d08f0d8',
      roleId: 'project_owner',
      validTo: '2027-09-25T02:24:58.089Z',
    },
    { assignmentId: '01a0d661-8d80-73fb-af78-90e3defb319e', roleId: 'performer', validTo: null },
  ],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('session assignments contract', () => {
  it('parses the live assignments and the clearance', () => {
    expect(parseSessionAssignments(BODY)).toEqual(BODY);
  });

  it.each([
    { ...BODY, clearance: 'top-secret' },
    { ...BODY, clearance: undefined },
    { ...BODY, assignments: 'none' },
    { ...BODY, assignments: [{ assignmentId: 'a', roleId: 'performer' }] },
    { ...BODY, assignments: [{ assignmentId: 1, roleId: 'performer', validTo: null }] },
    { ...BODY, organizationId: undefined },
    { ...BODY, assignments: Array.from({ length: 201 }, () => BODY.assignments[1]) },
    null,
  ])('refuses an off-contract body (%#)', (body) => {
    expect(() => parseSessionAssignments(body)).toThrow(/contract/);
  });

  it('asks with only the bearer token and the organization, never a guessed role', async () => {
    vi.stubEnv('KF_API_URL', 'http://api.example.test/');
    const fetch = vi.fn(async () => Response.json(BODY));
    vi.stubGlobal('fetch', fetch);
    await expect(getSessionAssignments('token-1', BODY.organizationId)).resolves.toEqual(BODY);
    expect(fetch).toHaveBeenCalledWith('http://api.example.test/session/assignments', {
      headers: { authorization: 'Bearer token-1', 'x-kf-organization': BODY.organizationId },
      cache: 'no-store',
    });
  });

  it('reports the API refusal by its code', async () => {
    vi.stubEnv('KF_API_URL', 'http://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'no_live_assignment' }, { status: 422 })),
    );
    const error = await getSessionAssignments('token-1', BODY.organizationId).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'no_live_assignment' });
  });
});
