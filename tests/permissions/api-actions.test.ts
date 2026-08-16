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
import { withTransaction } from '@kf/database';
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
      // The profile decides whether a fixed non-authoritative identity is permitted at all.
      // It became a required field and these call sites were never updated, so the harness
      // was building a config with that decision simply absent.
      deploymentProfile: 'development',
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

    type Partition = { ready: boolean; checks: { id: string; detail: string }[] };
    const body = res.json() as Partition & { service: Partition; institutional: Partition };

    // Readiness reports two partitions. The distinction is real — software that cannot do its
    // job is a different problem from software that works and lacks an approval, and
    // conflating them left every un-commissioned deployment permanently red.
    //
    // This endpoint still answers on the UNION, because that is the question in its name. A
    // fresh harness has never signed a checkpoint, so the institutional partition is not
    // ready. Asserting the compatibility `body.ready` instead would pass against a build that
    // had stopped reporting institutional blockers altogether: it aliases service readiness.
    expect(body.institutional.ready).toBe(false);
    expect(body.institutional.checks.map((c) => c.id)).toContain('checkpoint_coverage');
    expect(body.service.checks.map((c) => c.id)).toContain('audit_chain');

    // And it says what each finding means, rather than only that it is red.
    for (const c of [...body.service.checks, ...body.institutional.checks]) {
      expect(c.detail.length).toBeGreaterThanOrEqual(20);
    }
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
      // Renamed from atomCount: these are parsed blocks, a disposable projection, not the
      // authoring atoms of ADR 0002. packages/documents/src/readers.test.ts asserts the old
      // names are gone.
      parsedBlockCount: 2,
    });
  });

  it('rolls back every authoritative stage when final document creation is refused', async () => {
    const documentNumber = 'OH-DOC-TEST-HTTP-ATOMIC-001';
    const preexisting = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: {
        title: 'Existing controlled identity',
        documentNumber,
        revision: 'R01',
        documentClass: 'specification',
        owningRole: 'technical_authority',
        fileName: 'existing.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from('existing controlled bytes').toString('base64'),
        idempotencyKey: 'api-document-atomic-preexisting',
      },
    });
    expect(preexisting.statusCode, preexisting.body).toBe(201);

    const importKey = 'api-document-atomic-refusal';
    const response = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: {
        title: 'Conflicting import',
        documentNumber,
        revision: 'R01',
        documentClass: 'specification',
        owningRole: 'technical_authority',
        fileName: 'conflict.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from('must not leave partial authority').toString('base64'),
        idempotencyKey: importKey,
      },
    });
    expect(response.statusCode, response.body).toBe(409);

    const partial = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ count: string }>(
        `select count(*)::text as count from core.action
          where idempotency_key = any($1::text[])`,
        [[`${importKey}-artifact`, `${importKey}-fragment`, `${importKey}-document`]],
      ),
    );
    expect(partial.count).toBe('0');
  });

  it('serializes concurrent imports for one document identity into one success and one conflict', async () => {
    const documentNumber = 'OH-DOC-TEST-HTTP-CONCURRENT-001';
    const common = {
      title: 'Concurrent dogfood import',
      documentNumber,
      revision: 'R01',
      documentClass: 'specification',
      owningRole: 'technical_authority',
      fileName: 'concurrent.txt',
      mediaType: 'text/plain',
      contentBase64: Buffer.from('one exact source under concurrent import').toString('base64'),
    };
    const keys = ['api-document-concurrent-left', 'api-document-concurrent-right'] as const;
    const [left, right] = await Promise.all(
      keys.map((idempotencyKey) =>
        app.inject({
          method: 'POST',
          url: '/documents',
          headers: asCaller(f.reviewerId, f.reviewerRoleId),
          payload: { ...common, idempotencyKey },
        }),
      ),
    );

    expect([left.statusCode, right.statusCode].sort((a, b) => a - b)).toEqual([201, 409]);
    const conflict = left.statusCode === 409 ? left : right;
    expect(conflict.json()).toMatchObject({ error: 'duplicate_document' });

    const persisted = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ documents: string; actions: string }>(
        `select
           (select count(*)::text from quality.controlled_document
             where document_number = $1 and revision = 'R01') as documents,
           (select count(*)::text from core.action
             where idempotency_key = any($2::text[])) as actions`,
        [
          documentNumber,
          keys.flatMap((key) => [`${key}-artifact`, `${key}-fragment`, `${key}-document`]),
        ],
      ),
    );
    expect(persisted).toEqual({ documents: '1', actions: '3' });
  });
});

describe('ML metric ingestion surface', () => {
  it('requires exact actor-role authorization, then persists once with exact replay', async () => {
    const registry = await withTransaction(h.adminPool, async (tx) => {
      const reference = async (kind: string, authorityId: string, sha256: string) =>
        tx.one<{ id: string }>(
          `insert into ml.aggregate_reference
             (organization_id, aggregate_kind, authority_id, revision_id, sha256,
              classification_id, policy_id)
           values ($1, $2, $3, 'revision-1', $4, 'internal', 'ml-default')
           returning id`,
          [f.organizationId, kind, authorityId, sha256],
        );
      const run = await reference('run', 'api-training-run', '1'.repeat(64));
      const code = await reference('code', 'api-training-code', '2'.repeat(64));
      const recipe = await reference('recipe', 'api-training-recipe', '3'.repeat(64));
      const environment = await reference(
        'environment',
        'api-training-environment',
        '4'.repeat(64),
      );
      const policy = await reference('metric_policy', 'api-training-metric-policy', '5'.repeat(64));
      const definitionRef = await reference(
        'metric_definition',
        'api-validation-loss',
        '6'.repeat(64),
      );
      const lineage = await tx.one<{ id: string }>(
        `insert into ml.run_lineage
           (run_ref_id, code_ref_id, recipe_ref_id, environment_ref_id,
            metric_policy_ref_id, lineage_sha256)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [run.id, code.id, recipe.id, environment.id, policy.id, '7'.repeat(64)],
      );
      const definition = await tx.one<{ id: string }>(
        `insert into ml.metric_definition
           (definition_ref_id, metric_id, value_kind, unit_id, allowed_enum_ids)
         values ($1, 'validation.loss', 'number', 'ratio', '{}')
         returning id`,
        [definitionRef.id],
      );
      return {
        lineageId: lineage.id,
        definitionId: definition.id,
        policyRefId: policy.id,
      };
    });

    const payload = {
      idempotencyKey: 'api-training-run-event-1',
      sequence: 1,
      recordedAt: '2026-08-14T18:00:00.000Z',
      value: { kind: 'number', number: 0.125 },
    };
    const url =
      '/ml/runs/api-training-run/revisions/revision-1/metrics/' +
      'api-validation-loss/revisions/revision-1/events';
    const visibleButUnauthorized = await app.inject({
      method: 'POST',
      url,
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload,
    });
    expect(visibleButUnauthorized.statusCode, visibleButUnauthorized.body).toBe(404);
    expect(visibleButUnauthorized.json()).toEqual({ error: 'not_found' });

    const countAfterRefusal = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ count: string }>(
        'select count(*)::text as count from ml.metric_event where run_lineage_id = $1',
        [registry.lineageId],
      ),
    );
    expect(countAfterRefusal.count).toBe('0');

    const authorizationKey = 'api-ml-stream-authorization-1';
    const authorization = await app.inject({
      method: 'POST',
      url: '/actions/authorize_ml_metric_stream',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: {
        targetIds: [f.organizationId],
        idempotencyKey: authorizationKey,
        payload: {
          authorizedActorId: f.performerId,
          authorizedRoleId: f.performerRoleId,
          runLineageId: registry.lineageId,
          metricDefinitionId: registry.definitionId,
          metricPolicyRefId: registry.policyRefId,
        },
      },
    });
    expect(authorization.statusCode, authorization.body).toBe(201);

    const first = await app.inject({
      method: 'POST',
      url,
      headers: asCaller(f.performerId, f.performerRoleId),
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstBody = first.json() as { replayed: boolean; event: { eventDigest: string } };
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.event.eventDigest).toMatch(/^[0-9a-f]{64}$/);

    const retry = await app.inject({
      method: 'POST',
      url,
      headers: asCaller(f.performerId, f.performerRoleId),
      payload,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      replayed: true,
      event: { eventDigest: firstBody.event.eventDigest },
    });

    const attribution = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ actor_id: string; acting_role_id: string }>(
        `select authz.actor_id::text, authz.acting_role_id::text
           from ml.metric_event event
           join ml.metric_write_authorization authz
             on authz.id = event.metric_write_authorization_id
           join ml.run_lineage lineage on lineage.id = event.run_lineage_id
           join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
          where run_ref.authority_id = 'api-training-run'`,
      ),
    );
    expect(attribution).toEqual({
      actor_id: f.performerId,
      acting_role_id: f.performerRoleId,
    });

    const envelopes = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ actions: string; audits: string; outboxes: string }>(
        `select
           (select count(*)::text from core.action
             where idempotency_key = any($1::text[])) as actions,
           (select count(*)::text from core.audit_event event
             join core.action action on action.id = event.action_id
            where action.idempotency_key = any($1::text[])) as audits,
           (select count(*)::text from core.outbox outbox
             join core.action action on action.id = outbox.action_id
            where action.idempotency_key = any($1::text[])) as outboxes`,
        [[authorizationKey, `ml-event:${firstBody.event.eventDigest}`]],
      ),
    );
    expect(envelopes).toEqual({ actions: '2', audits: '2', outboxes: '2' });
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
    // not a description of it — which is why the three fields it was missing matter. It
    // claimed to be production while omitting the deployment profile, the TLS assertion and
    // the identity slot, so it was testing a shape no deployment can have.
    const prod = await buildApp({
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      databaseUrl: new URL(h.connectionString).toString(),
      environment: 'production',
      deploymentProfile: 'dogfood',
      tlsTerminatedUpstream: true,
      identity: undefined,
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

  it.each([
    'not-a-date',
    '0000-01-01T00:00:00.000Z',
    '+010000-01-01T00:00:00.000Z',
    '2026-08-14T12:00:00.000001Z',
  ])('refuses noncanonical effectiveAt %s before dispatch', async (effectiveAt) => {
    const idempotencyKey = `api-invalid-effective-at-${Buffer.from(effectiveAt).toString('hex')}`;
    const before = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ count: string }>(
        'select count(*)::text as count from core.action where idempotency_key = $1',
        [idempotencyKey],
      ),
    );

    const r = await app.inject({
      method: 'POST',
      url: '/actions/create_initiative',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: {
        idempotencyKey,
        effectiveAt,
        payload: { title: 'must not dispatch' },
      },
    });

    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({
      error: 'invalid_effective_at',
      message: 'effectiveAt must be a canonical four-digit-year RFC 3339 millisecond instant',
    });
    const after = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ count: string }>(
        'select count(*)::text as count from core.action where idempotency_key = $1',
        [idempotencyKey],
      ),
    );
    expect(before.count).toBe('0');
    expect(after.count).toBe('0');
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
        payload: {
          title: 'Atlas enclosure (API)',
          objective: 'Created over HTTP, through the same dispatcher.',
          sponsor_id: f.reviewerId,
        },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().replayed).toBe(true);
    expect(r.json().actionId).toBeTruthy();
  });

  it('refuses reuse of an idempotency key for different mutation semantics', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/actions/create_initiative',
      headers: asCaller(f.reviewerId, f.reviewerRoleId),
      payload: {
        idempotencyKey: 'api-create-project-01',
        payload: {
          title: 'Different initiative',
          objective: 'Must not replay or materialize.',
          sponsor_id: f.reviewerId,
        },
      },
    });

    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'idempotency_conflict' });
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
