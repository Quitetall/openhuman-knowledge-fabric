import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { AttestorUnavailable, IdentityRejected, type Holdings } from '@kf/authorization';
import { registerSessionRoutes } from '../../apps/api/src/routes/session.js';
import type {
  Caller,
  IdentifyCaller,
  ListHoldings,
} from '../../apps/api/src/routes/actions/contracts.js';
import { seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';
import { assignElsewhere } from './people.js';

/**
 * `GET /session/assignments` answers a signed-in person with their own live assignments and
 * clearance, read under their own bound context (2026-09-24). Against a real database, because
 * what is under test is that the assignment rows (which are `internal` records) are read through
 * row-level security at the ceiling the route binds: the highest the resolver grants.
 *
 * The identifier is a stand-in for kf-attestor, deciding the same three outcomes: one live
 * assignment (derived), several (`assignment_ambiguous`, listing them), none. What it does not
 * cover is the attestor's own verification of a token, which tests/permissions/attestor.test.ts
 * holds.
 */

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

type Outcome = 'sole' | 'several' | 'none';

const RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function identifier(
  person: 'reviewer' | 'performer',
  outcome: Outcome,
  cleared = 'restricted',
): IdentifyCaller {
  const actorId = person === 'reviewer' ? fixtures.reviewerId : fixtures.performerId;
  const assignmentId = person === 'reviewer' ? fixtures.reviewerRoleId : fixtures.performerRoleId;
  return async ({ headers, deriveAssignment }) => {
    const named = String(headers['x-kf-acting-role'] ?? '');
    if (named === '' && deriveAssignment === true) {
      if (outcome === 'none') throw new IdentityRejected('no_live_assignment', 'none held');
      if (outcome === 'several') {
        throw new IdentityRejected('assignment_ambiguous', 'several held', [
          { assignmentId, roleId: 'whatever', scopeId: fixtures.organizationId },
        ]);
      }
    } else if (named !== assignmentId) {
      throw new IdentityRejected('role_not_held', 'not held');
    }
    if ((RANK[String(headers['x-kf-classification'])] ?? 9) > (RANK[cleared] ?? -1)) {
      throw new IdentityRejected('classification_not_granted', 'classification ceiling refused');
    }
    const caller: Caller = {
      actorId,
      actingRoleId: assignmentId,
      organizationId: fixtures.organizationId,
      maxClassification: String(headers['x-kf-classification']),
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    };
    return caller;
  };
}

const noHoldings: ListHoldings = async () => {
  throw new Error('this test does not list holdings');
};

async function app(
  identify: IdentifyCaller,
  holdings: ListHoldings = noHoldings,
): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  registerSessionRoutes(instance, { pool: harness.pool, identify, holdings });
  await instance.ready();
  return instance;
}

describe('GET /session/assignments', () => {
  it('answers a person with one assignment with it, their role and their clearance', async () => {
    const response = await (
      await app(identifier('reviewer', 'sole'))
    ).inject({ method: 'GET', url: '/session/assignments' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual({
      organizationId: fixtures.organizationId,
      personId: fixtures.reviewerId,
      clearance: 'restricted',
      assignments: [
        {
          assignmentId: fixtures.reviewerRoleId,
          roleId: 'technical_authority',
          validTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ],
    });
  });

  it('answers a person with several by listing them, read under one of them', async () => {
    const response = await (
      await app(identifier('performer', 'several'))
    ).inject({ method: 'GET', url: '/session/assignments' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      personId: fixtures.performerId,
      assignments: [{ assignmentId: fixtures.performerRoleId, roleId: 'performer' }],
    });
  });

  it('reports as the clearance the highest ceiling the resolver will bind, and no higher', async () => {
    const response = await (
      await app(identifier('reviewer', 'sole', 'confidential'))
    ).inject({ method: 'GET', url: '/session/assignments' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ clearance: 'confidential' });
  });

  it('answers a person with none that there is nothing to choose, and lists nothing', async () => {
    const response = await (
      await app(identifier('reviewer', 'none'))
    ).inject({ method: 'GET', url: '/session/assignments' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'no_live_assignment' });
  });

  it('refuses an unidentified caller as every route does, naming nothing', async () => {
    const refusing: IdentifyCaller = async () => {
      throw new IdentityRejected('unknown_subject', 'not linked');
    };
    const response = await (
      await app(refusing)
    ).inject({ method: 'GET', url: '/session/assignments' });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(fixtures.reviewerRoleId);
  });
});

/**
 * `GET /session/contexts`: every organization the person holds a live assignment in, each
 * described as `GET /session/assignments` describes it. The stand-ins here are the attestor's two
 * answers — the holdings list, and identifying in one organization — over a real second
 * organization, so each organization's assignments are read under the person's own bound context
 * there.
 */
describe('GET /session/contexts', () => {
  let elsewhere: Fixtures;
  let reviewerInB: string;

  beforeAll(async () => {
    elsewhere = await seedFixtures(harness.adminPool);
    // The reviewer of the first organization also holds a performer role in the second, cleared
    // there at `internal` only.
    reviewerInB = await assignElsewhere(harness.adminPool, elsewhere, {
      personId: fixtures.reviewerId,
      role: 'performer',
      clearance: 'internal',
    });
  }, 120_000);

  const holdingsOfReviewer = (): Holdings => ({
    personId: fixtures.reviewerId,
    organizations: [
      {
        organizationId: fixtures.organizationId,
        legalName: 'First Org',
        assignments: [
          {
            assignmentId: fixtures.reviewerRoleId,
            roleId: 'technical_authority',
            scopeId: fixtures.organizationId,
          },
        ],
      },
      {
        organizationId: elsewhere.organizationId,
        legalName: 'Second Org',
        assignments: [
          { assignmentId: reviewerInB, roleId: 'performer', scopeId: elsewhere.organizationId },
        ],
      },
    ],
  });

  /** Identify the reviewer in either organization, as the attestor would, cleared per org. */
  function reviewerEverywhere(
    cleared: Readonly<Record<string, string>>,
    seen: Record<string, unknown>[] = [],
  ): IdentifyCaller {
    return async ({ headers }) => {
      seen.push(headers);
      const held: Readonly<Record<string, string>> = {
        [fixtures.organizationId]: fixtures.reviewerRoleId,
        [elsewhere.organizationId]: reviewerInB,
      };
      const organizationId = String(headers['x-kf-organization'] ?? '');
      const assignmentId = String(headers['x-kf-acting-role'] ?? '');
      if (held[organizationId] !== assignmentId) {
        throw new IdentityRejected('role_not_held', 'not held');
      }
      const level = String(headers['x-kf-classification']);
      if ((RANK[level] ?? 9) > (RANK[cleared[organizationId] ?? ''] ?? -1)) {
        throw new IdentityRejected('classification_not_granted', 'classification ceiling refused');
      }
      const caller: Caller = {
        actorId: fixtures.reviewerId,
        actingRoleId: assignmentId,
        organizationId,
        maxClassification: level,
        authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
      };
      return caller;
    };
  }

  const bothCleared = (): Record<string, string> => ({
    [fixtures.organizationId]: 'restricted',
    [elsewhere.organizationId]: 'internal',
  });

  const ask = async (identify: IdentifyCaller, holdings: ListHoldings, headers = {}) =>
    (await app(identify, holdings)).inject({
      method: 'GET',
      url: '/session/contexts',
      headers: { authorization: 'Bearer t', ...headers },
    });

  it('lists every organization with its legal name, clearance and assignments', async () => {
    const response = await ask(reviewerEverywhere(bothCleared()), async () => holdingsOfReviewer());
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const validTo = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.json()).toEqual({
      personId: fixtures.reviewerId,
      organizations: [
        {
          organizationId: fixtures.organizationId,
          legalName: 'First Org',
          clearance: 'restricted',
          assignments: [
            { assignmentId: fixtures.reviewerRoleId, roleId: 'technical_authority', validTo },
          ],
          refused: null,
        },
        {
          organizationId: elsewhere.organizationId,
          legalName: 'Second Org',
          clearance: 'internal',
          assignments: [{ assignmentId: reviewerInB, roleId: 'performer', validTo }],
          refused: null,
        },
      ],
    });
  });

  it('hands the holdings lookup the bearer token and nothing that could name anybody', async () => {
    const asked: Record<string, unknown>[] = [];
    const identified: Record<string, unknown>[] = [];
    const response = await ask(
      reviewerEverywhere(bothCleared(), identified),
      async ({ headers }) => {
        asked.push(headers);
        return holdingsOfReviewer();
      },
      {
        'x-kf-actor': fixtures.performerId,
        'x-kf-organization': elsewhere.organizationId,
        'x-kf-acting-role': fixtures.performerRoleId,
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(asked).toEqual([{ authorization: 'Bearer t' }]);
    expect(identified.length).toBeGreaterThan(0);
    for (const headers of identified) {
      expect(headers['x-kf-actor']).toBeUndefined();
      expect(headers['x-kf-acting-role']).not.toBe(fixtures.performerRoleId);
    }
  });

  it('describes an organization it cannot identify the person in as refused, listing nothing there', async () => {
    const response = await ask(
      reviewerEverywhere({ [fixtures.organizationId]: 'restricted' }),
      async () => holdingsOfReviewer(),
    );
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { organizations: unknown[] };
    expect(body.organizations[1]).toEqual({
      organizationId: elsewhere.organizationId,
      legalName: 'Second Org',
      clearance: null,
      assignments: [],
      refused: 'classification_not_granted',
    });
    expect(response.body).not.toContain(reviewerInB);
  });

  it.each([
    ['unknown_subject', 401],
    ['revoked_identity', 401],
    ['invalid_token', 401],
    ['no_live_assignment', 422],
  ] as const)('refuses a caller the holdings lookup refuses as %s', async (failure, status) => {
    const response = await ask(reviewerEverywhere(bothCleared()), async () => {
      throw new IdentityRejected(failure, 'refused');
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: failure });
  });

  it('refuses the whole answer when identifying refuses the caller, naming no organization', async () => {
    const refusing: IdentifyCaller = async () => {
      throw new IdentityRejected('undeclared_agent', 'not a declared agent');
    };
    const response = await ask(refusing, async () => holdingsOfReviewer());
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'undeclared_agent' });
    expect(response.body).not.toContain('Second Org');
    expect(response.body).not.toContain(elsewhere.organizationId);
  });

  it('refuses to list when the attestor identifies somebody other than the one it listed', async () => {
    const response = await ask(reviewerEverywhere(bothCleared()), async () => ({
      ...holdingsOfReviewer(),
      personId: fixtures.performerId,
    }));
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(fixtures.reviewerRoleId);
    expect(response.body).not.toContain(reviewerInB);
  });

  it('answers 503 while the attestor cannot be asked', async () => {
    const response = await ask(reviewerEverywhere(bothCleared()), async () => {
      throw new AttestorUnavailable('/run/kf/attestor.sock', 'ECONNREFUSED');
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'attestor_unavailable' });
  });
});
