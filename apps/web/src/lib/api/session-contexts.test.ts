import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';
import { getSessionContexts, parseSessionContexts } from './session-contexts.js';

const ORG_A = '01a0d661-0aae-71e9-954f-fb10fb1222db';
const ORG_B = '01a0d661-0aae-71e9-954f-fb10fb1222dc';

const BODY = {
  personId: '01a0d661-0ab4-7f1b-bf8c-19d9780b243d',
  organizations: [
    {
      organizationId: ORG_A,
      legalName: 'Redwood Inference',
      clearance: 'restricted',
      assignments: [
        {
          assignmentId: 'f03a6a9e-a2e4-4c23-94d9-d8db1d08f0d8',
          roleId: 'project_owner',
          validTo: '2027-09-25T02:24:58.089Z',
        },
      ],
      refused: null,
    },
    {
      organizationId: ORG_B,
      legalName: 'MediConn Solutions',
      clearance: null,
      assignments: [],
      refused: 'classification_not_granted',
    },
  ],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const described = BODY.organizations[0]!;
const refused = BODY.organizations[1]!;

describe('session contexts contract', () => {
  it('parses every organization, described or refused', () => {
    expect(parseSessionContexts(BODY)).toEqual(BODY);
  });

  it.each([
    null,
    { ...BODY, personId: undefined },
    { ...BODY, organizations: 'all' },
    { ...BODY, organizations: [described, described] },
    { ...BODY, organizations: [{ ...described, legalName: undefined }] },
    { ...BODY, organizations: [{ ...described, clearance: 'top-secret' }] },
    { ...BODY, organizations: [{ ...described, assignments: [] }] },
    { ...BODY, organizations: [{ ...described, refused: 'role_not_held' }] },
    { ...BODY, organizations: [{ ...refused, clearance: 'internal' }] },
    { ...BODY, organizations: [{ ...refused, assignments: described.assignments }] },
    {
      ...BODY,
      organizations: [{ ...described, assignments: [{ assignmentId: 'a', roleId: 'r' }] }],
    },
    {
      ...BODY,
      organizations: Array.from({ length: 65 }, (_, i) => ({
        ...refused,
        organizationId: `${ORG_A}-${i}`,
      })),
    },
  ])('refuses an off-contract body (%#)', (body) => {
    expect(() => parseSessionContexts(body)).toThrow(/contract/);
  });

  it('asks with only the bearer token: no organization, no role, no person', async () => {
    vi.stubEnv('KF_API_URL', 'http://api.example.test/');
    const fetch = vi.fn(async () => Response.json(BODY));
    vi.stubGlobal('fetch', fetch);
    await expect(getSessionContexts('token-1')).resolves.toEqual(BODY);
    expect(fetch).toHaveBeenCalledWith('http://api.example.test/session/contexts', {
      headers: { authorization: 'Bearer token-1' },
      cache: 'no-store',
    });
  });

  it('reports the API refusal by its code', async () => {
    vi.stubEnv('KF_API_URL', 'http://api.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'no_live_assignment' }, { status: 422 })),
    );
    const error = await getSessionContexts('token-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'no_live_assignment' });
  });
});
