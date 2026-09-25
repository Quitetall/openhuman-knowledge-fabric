import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { IdentityRejected } from '@kf/authorization';
import { registerSessionRoutes } from '../../apps/api/src/routes/session.js';
import type { Caller, IdentifyCaller } from '../../apps/api/src/routes/actions/contracts.js';
import { seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

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

async function app(identify: IdentifyCaller): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  registerSessionRoutes(instance, { pool: harness.pool, identify });
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
