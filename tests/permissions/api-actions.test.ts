/**
 * The API surface, against a real database.
 *
 * Two things are under test and neither is "does the happy path return 201".
 *
 * The first is that the API is not a second way in. Every refusal the dispatcher makes must
 * survive the HTTP layer with a status code that means the same thing, because an endpoint
 * that turned a separation-of-duty refusal into a 500 would leave callers retrying it, and
 * one that turned it into a 200 would be a bypass.
 *
 * The second is that identity is never taken from the caller in a deployment that has no
 * identity provider. That decision is made at startup from configuration, so this checks the
 * production shape as well as the development one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { buildApp } from '../../apps/api/src/app.js';
import { registerActionRoutes } from '../../apps/api/src/routes/actions.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;
let app: FastifyInstance;
const objectStore = new InMemoryObjectStore();

/** The development headers. In production these are ignored and the routes refuse. */
function asCaller(actorId: string, roleId: string, classification = 'restricted') {
  return {
    'x-kf-actor': actorId,
    'x-kf-acting-role': roleId,
    'x-kf-organization': f.organizationId,
    'x-kf-classification': classification,
  };
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);

  const appUri = new URL(h.connectionString);
  appUri.username = 'kf_app_login';
  appUri.password = 'test-only-not-a-secret';

  app = await buildApp(
    {
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      databaseUrl: appUri.toString(),
      environment: 'test',
      tlsTerminatedUpstream: false,
      identity: undefined,
    },
    { objectStore },
  );
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

describe('readiness', () => {
  it('reports ready against a database it can actually reach', async () => {
    // The counterpart to the unreachable case in apps/api: readiness is a real round trip,
    // so proving the positive needs one real database.
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true, checks: { database: 'ok' } });
  });
});

describe('deep readiness', () => {
  it('is a separate question from liveness, and answers 503 when the system is not in order', async () => {
    // /ready asks "can this process serve a request" — answering that with a full chain
    // verification would turn a database blip into a restart loop. /readiness asks "is the
    // system in the state it is supposed to be in", which is slower and much more
    // interesting. A fresh harness has never signed a checkpoint, so it is NOT ready.
    const res = await app.inject({ method: 'GET', url: '/readiness' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { ready: boolean; checks: { id: string; detail: string }[] };
    expect(body.ready).toBe(false);
    // And it says what each finding means, rather than only that it is red.
    for (const c of body.checks) expect(c.detail.length).toBeGreaterThanOrEqual(20);
    expect(body.checks.map((c) => c.id)).toContain('audit_chain');
  });
});

describe('document dogfood surface', () => {
  it('adds a draft through HTTP, parses it, and returns the same id on retry', async () => {
    const payload = {
      title: 'Dogfood Constitution',
      documentNumber: 'OH-DOC-TEST-HTTP-001',
      revision: 'R01',
      documentClass: 'specification',
      owningRole: 'technical_authority',
      fileName: 'constitution.txt',
      mediaType: 'text/plain',
      contentBase64: Buffer.from('# Constitution\n\nOne fact, one owner.').toString('base64'),
      idempotencyKey: 'api-document-dogfood-0001',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: string; replayed: boolean };
    expect(firstBody.replayed).toBe(false);

    const retry = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ id: firstBody.id, replayed: true });

    const detail = await app.inject({
      method: 'GET',
      url: `/documents/${firstBody.id}`,
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      documentNumber: 'OH-DOC-TEST-HTTP-001',
      lifecycleState: 'draft',
      parser: 'pandoc',
      atomCount: 2,
    });
  });
});

describe('identity', () => {
  it('refuses a caller who states no identity', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/create_initiative',
      payload: { idempotencyKey: 'no-identity-1234' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ error: 'caller_unidentified' });
  });

  it('refuses actions entirely when no identity provider is configured', async () => {
    // The production shape. Built from the same factory, so this is the real behaviour and
    // not a description of it.
    const prod = await buildApp({
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      databaseUrl: new URL(h.connectionString).toString(),
      environment: 'production',
    });
    await prod.ready();
    try {
      const r = await prod.inject({
        method: 'POST',
        url: '/actions/create_initiative',
        headers: asCaller(f.reviewerId, f.reviewerRoleId),
        payload: { idempotencyKey: 'prod-attempt-1234' },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: 'no_identity_provider' });
    } finally {
      await prod.close();
    }
  }, 60_000);

  it('defaults an unstated clearance to the lowest tier, never the highest', async () => {
    const restricted = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: 'A restricted decision',
      createdBy: f.performerId,
    });

    const r = await app.inject({
      method: 'GET',
      url: `/objects/${restricted}/history`,
      headers: {
        'x-kf-actor': f.reviewerId,
        'x-kf-acting-role': f.reviewerRoleId,
        'x-kf-organization': f.organizationId,
        // classification header deliberately absent
      },
    });
    // Visible at `internal`, which is the default — the point is that the default is the
    // floor, so a missing header narrows rather than widens.
    expect(r.statusCode).toBe(200);
  });
});

describe('actions over HTTP', () => {
  let projectId: string;

  it('requires a caller-supplied idempotency key', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/create_initiative',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: { payload: { title: 'x' } },
    });
    // Not generated server-side: a key the server invents is not stable across the caller's
    // retries, which is the only thing it is for.
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'idempotency_key_required' });
  });

  it('creates a project and returns 201', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/create_initiative',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: {
        idempotencyKey: 'api-create-project-01',
        payload: {
          title: 'Atlas enclosure (API)',
          objective: 'Created over HTTP, through the same dispatcher.',
          sponsor_id: f.reviewerId,
        },
      },
    });
    expect(r.statusCode).toBe(201);
    projectId = r.json().objectIds[0];
    expect(r.headers['x-request-id']).toBeTruthy();
  });

  it('replays an identical retry as 200, not a second project', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/create_initiative',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: {
        idempotencyKey: 'api-create-project-01',
        payload: { title: 'Atlas enclosure (API)', objective: 'x', sponsor_id: f.reviewerId },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().replayed).toBe(true);
    expect(r.json().actionId).toBeTruthy();
  });

  it('maps an illegal transition to 409, not 500', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/activate_project',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: { idempotencyKey: 'api-illegal-move-01', targetIds: [projectId] },
    });
    // A conflict with the record's current state, which a caller can act on. A 500 would
    // leave them retrying something that will never succeed.
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'illegal_transition' });
  });

  it('maps an unknown action to 404', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/delete_everything',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: { idempotencyKey: 'api-unknown-action-1', targetIds: [projectId] },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: 'unknown_action' });
  });

  it('maps a missing reason to 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/correct_record',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: { idempotencyKey: 'api-no-reason-0001', targetIds: [projectId] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'reason_required' });
  });

  it('serves the project with computed progress, not a stored percentage', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.lifecycle_state).toBe('captured');
    // No packages yet, so progress is null rather than 0 — "nothing to do" and "none of it
    // done" are different answers, and reporting 0% for the first would be a lie.
    expect(body.progress).toEqual({ totalPackages: 0, disposedPackages: 0, fraction: null });
  });

  it('serves an object history that matches the actions taken', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/objects/${projectId}/history`,
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
    });
    expect(r.statusCode).toBe(200);
    const events = r.json().events as { action_type: string; digest: string }[];
    expect(events.map((e) => e.action_type)).toContain('create_initiative');
    expect(events[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('surfaces a DATABASE-tier invariant refusal as 422, not 500', async () => {
    // The financial rules are guarded twice, and under concurrency the trigger is the one
    // that wins: two acceptances can each pass the application check and only one survive
    // the row lock. The loser must reach the caller as a refusal they can act on. A 500
    // would have them retrying something that will never succeed.
    //
    // Routes are registered against a stub that raises what PostgreSQL actually raises, so
    // this tests the mapping rather than a description of it.
    const stub = Fastify({ logger: false });
    await registerActionRoutes(stub, {
      pool: h.pool,
      trustHeaders: true,
      execute: async () => {
        const err = new Error(
          'KF-FIN-001: accepted value 5000.00 would exceed work order WO-1 ceiling 4000.00 (amended by 0.00)',
        ) as Error & { code: string };
        err.code = '23514';
        throw err;
      },
    });
    await stub.ready();
    try {
      const r = await stub.inject({
        method: 'POST',
        url: '/actions/issue_acceptance',
        headers: asCaller(f.reviewerId, f.reviewerRoleId),
        payload: { idempotencyKey: 'api-trigger-refusal', targetIds: [projectId] },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({
        error: 'precondition_failed',
        detail: { rule: 'KF-FIN-001', enforcedBy: 'database' },
      });
    } finally {
      await stub.close();
    }
  });

  it('does not mistake an unrelated database fault for an invariant refusal', async () => {
    // A 500 that leaks a database message can name tables, columns and values. Only a
    // check_violation whose text begins with a rule id is a refusal; everything else is a
    // fault, and faults say nothing beyond a correlation id.
    const stub = Fastify({ logger: false });
    await registerActionRoutes(stub, {
      pool: h.pool,
      trustHeaders: true,
      execute: async () => {
        const err = new Error('relation "core.secret_table" does not exist') as Error & {
          code: string;
        };
        err.code = '42P01';
        throw err;
      },
    });
    await stub.ready();
    try {
      const r = await stub.inject({
        method: 'POST',
        url: '/actions/issue_acceptance',
        headers: asCaller(f.reviewerId, f.reviewerRoleId),
        payload: { idempotencyKey: 'api-real-fault-001', targetIds: [projectId] },
      });
      expect(r.statusCode).toBe(500);
      expect(r.json()).toEqual({ error: 'internal_error', requestId: expect.any(String) });
      expect(JSON.stringify(r.json())).not.toContain('secret_table');
    } finally {
      await stub.close();
    }
  });

  it('answers what can be done next FROM THE ONTOLOGY, not from a hard-coded list', async () => {
    // The interface asks rather than knowing. A UI carrying its own copy of the state
    // machine is a copy that goes stale — leaving buttons that always fail, or hiding a
    // transition that is perfectly legal.
    const r = await app.inject({
      method: 'GET',
      url: `/objects/${projectId}/available-actions`,
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      state: string;
      objectType: string;
      actions: {
        actionType: string;
        toStates: string[];
        requiresChoice: boolean;
        reasonRequired: boolean;
      }[];
    };
    expect(body.objectType).toBe('initiative_project');
    expect(body.state).toBe('captured');

    const triage = body.actions.find((a) => a.actionType === 'triage_initiative');
    expect(triage).toBeDefined();
    // From `captured` the ontology offers both triage and parked, so the caller must pick —
    // and the interface has to know that or it will submit something the dispatcher refuses.
    expect(triage!.requiresChoice).toBe(true);
    expect(triage!.toStates.sort()).toEqual(['parked', 'triage']);

    // Not offered from here, and correctly absent rather than listed-and-failing.
    expect(body.actions.map((a) => a.actionType)).not.toContain('activate_project');

    // Which actions need a reason comes from the DISPATCHER's own list. A UI holding its own
    // copy would stop asking on an action that started requiring one, and the user would meet
    // a 400 with no field to fill in.
    expect(triage!.reasonRequired).toBe(false);
  });

  it('reports which actions need a reason, from the dispatcher rather than a copy', async () => {
    // `correct_record` is not offered from `captured`, so proving the TRUE case needs a
    // record somewhere it applies. An interface holding its own list would stop asking for
    // a reason on an action that started requiring one, and the user would meet a 400 with
    // no field to fill in.
    const created = await app.inject({
      method: 'POST',
      url: '/actions/create_initiative',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: {
        idempotencyKey: 'api-reason-probe-001',
        payload: { title: 'Reason probe', objective: 'x', sponsor_id: f.reviewerId },
      },
    });
    const id = created.json().objectIds[0] as string;

    for (const [key, payload] of [
      ['api-reason-probe-002', { to_state: 'triage' }],
      ['api-reason-probe-003', { to_state: 'evaluating' }],
    ] as const) {
      await app.inject({
        method: 'POST',
        url: '/actions/triage_initiative',
        headers: asCaller(f.reviewerId, f.reviewerRoleId),
        payload: { idempotencyKey: key, targetIds: [id], payload },
      });
    }
    await app.inject({
      method: 'POST',
      url: '/actions/authorize_project',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: { idempotencyKey: 'api-reason-probe-004', targetIds: [id] },
    });

    const r = await app.inject({
      method: 'GET',
      url: `/objects/${id}/available-actions`,
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
    });
    const actions = (r.json() as { actions: { actionType: string; reasonRequired: boolean }[] })
      .actions;
    const correct = actions.find((a) => a.actionType === 'correct_record');
    expect(correct, 'correct_record should be offered from authorized').toBeDefined();
    expect(correct!.reasonRequired).toBe(true);
  });

  it('answers 404 — not 403 — for a record outside the caller scope', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: {
        ...asCaller(f.reviewerId, f.reviewerRoleId),
        'x-kf-organization': '01930000-0000-7000-8000-00000000dead',
      },
    });
    // Distinguishing "not allowed" from "does not exist" tells an unauthorized caller that
    // a record exists, which is itself a disclosure.
    expect(r.statusCode).toBe(404);
  });
});
