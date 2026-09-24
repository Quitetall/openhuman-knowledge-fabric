/**
 * An observation, end to end (KF-SAS-RQ-202, RQ-203; ADR 0034; SAS §48A).
 *
 * One real API process listening on a port, one real database. A person with one live
 * assignment and no act grant notes something with `kf note` — the command itself, over HTTP —
 * and then, as other people do to it:
 *
 *   1. it exists from the first moment as a `captured` observation, attributed to them, with an
 *      audit event in the chain (RQ-202: attributed and audited from the moment it is written);
 *   2. it reads as UNVERIFIED on an Object View (§48A);
 *   3. somebody else verifies it with `verify_record`, and it reads as verified, naming them;
 *   4. its author cannot promote it — capture is cheap, promotion is institutional — and
 *      somebody holding act authority can, as a separate act (RQ-202).
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { buildApp } from '../../apps/api/src/app.js';
import { runNoteCommand } from '../../apps/api/src/note/cli.js';
import { seedFixtures, startHarness, type Fixtures, type Harness } from '../database/harness.js';
import { enrolPerson, fixtureProject, type EnrolledPerson } from '../database/people.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ARTIFACT = join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json');

let h: Harness;
let f: Fixtures;
let app: FastifyInstance;
let origin: string;
let noter: EnrolledPerson;
let observationId: string;

function sink(): Writable & { text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write: (chunk: Buffer, _enc, done) => {
      chunks.push(chunk.toString());
      done();
    },
  }) as Writable & { text(): string };
  stream.text = () => chunks.join('');
  return stream;
}

const asReviewer = () => ({
  'x-kf-actor': f.reviewerId,
  'x-kf-acting-role': f.reviewerRoleId,
  'x-kf-organization': f.organizationId,
  'x-kf-classification': 'restricted',
});

const asNoter = () => ({
  'x-kf-actor': noter.personId,
  'x-kf-acting-role': noter.assignmentIds[0]!,
  'x-kf-organization': f.organizationId,
  'x-kf-classification': 'restricted',
});

interface ViewMember {
  readonly objectId: string;
  readonly lifecycleState?: string;
  readonly verification: { readonly verified: boolean; readonly label: string };
}

/** The observation as an Object View shows it to the reviewer, after bringing their record current. */
async function viewed(): Promise<ViewMember> {
  const res = await app.inject({
    method: 'POST',
    url: `/objects/${observationId}/refresh`,
    headers: asReviewer(),
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { result: { sections: { members: ViewMember[] }[] } };
  const subject = body.result.sections[0]!.members[0]!;
  expect(subject.objectId).toBe(observationId);
  return subject;
}

const stateOf = async (id: string) =>
  (
    await withTransaction(h.adminPool, (tx) =>
      tx.one<{ lifecycle_state: string }>('select lifecycle_state from core.object where id = $1', [
        id,
      ]),
    )
  ).lifecycle_state;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  const project = await fixtureProject(h.adminPool, f, 'Front-end bench');
  noter = await enrolPerson(h.adminPool, f, {
    name: 'Bench engineer',
    assignments: [{ role: 'performer', scopeId: project }],
  });
  app = await buildApp(
    {
      host: '127.0.0.1',
      port: 0,
      logLevel: process.env['LOG_LEVEL'] ?? 'silent',
      databaseUrl: h.developmentDatabaseUrl,
      environment: 'test',
      deploymentProfile: 'development',
      tlsTerminatedUpstream: false,
      identity: undefined,
      projectionsArtifact: ARTIFACT,
    },
    { objectStore: new InMemoryObjectStore() },
  );
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

describe('an observation from capture to controlled record', () => {
  it('is captured by `kf note`, over HTTP, as a draft attributed and audited from the first moment', async () => {
    const out = sink();
    const err = sink();
    const code = await runNoteCommand(
      [
        'Channel 3 noise floor 2.1 µV RMS at 250 Hz on board B.',
        '--identity',
        'dev',
        '--api',
        origin,
        '--tag',
        'bench',
        '--json',
      ],
      {
        NODE_ENV: 'development',
        KF_ALLOW_FIXED_IDENTITY: '1',
        KF_DEV_ACTOR: noter.personId,
        KF_DEV_ORGANIZATION: f.organizationId,
      },
      out,
      err,
    );
    expect(code, err.text()).toBe(0);
    const answer = JSON.parse(out.text()) as {
      observationId: string;
      actionId: string;
      lifecycleState: string;
      actingRoleId: string;
      verification: { verified: boolean; label: string };
    };
    observationId = answer.observationId;
    expect(answer).toMatchObject({
      lifecycleState: 'captured',
      actingRoleId: noter.assignmentIds[0],
      verification: { verified: false, label: 'UNVERIFIED — nobody has checked this record' },
    });

    const recorded = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ created_by: string; events: number; actor: string }>(
        `select o.created_by,
                (select count(*)::int from core.audit_event e where e.action_id = $2) as events,
                (select a.actor_id::text from core.action a where a.id = $2) as actor
           from core.object o where o.id = $1`,
        [observationId, answer.actionId],
      ),
    );
    expect(recorded).toEqual({ created_by: noter.personId, events: 1, actor: noter.personId });
  });

  it('reads as unverified to somebody else', async () => {
    const member = await viewed();
    expect(member.verification).toEqual({
      verified: false,
      label: 'UNVERIFIED — nobody has checked this record',
    });
    expect(await stateOf(observationId)).toBe('captured');
  });

  it('is verified by another person, and then reads as verified, naming them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/actions/verify_record',
      headers: asReviewer(),
      payload: {
        targetIds: [observationId],
        payload: { basis: 'reviewed_individually' },
        reason: 'checked against the bench log for board B',
        idempotencyKey: `verify-${randomUUID()}`,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const member = await viewed();
    expect(member.verification.verified).toBe(true);
    expect(member.verification.label).toMatch(/^verified /);
    expect(member.verification.label).toContain(f.reviewerId);
  });

  it('cannot be promoted by its author, who holds no act grant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/actions/promote_observation',
      headers: asNoter(),
      payload: { targetIds: [observationId], idempotencyKey: `promote-${randomUUID()}` },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: 'act_not_granted' });
    expect(await stateOf(observationId)).toBe('captured');
  });

  it('is promoted by an act holder, as a separate act', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/actions/promote_observation',
      headers: asReviewer(),
      payload: { targetIds: [observationId], idempotencyKey: `promote-${randomUUID()}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(await stateOf(observationId)).toBe('promoted');
    const acts = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ action_type: string; actor_id: string }>(
        `select action_type, actor_id::text as actor_id from core.action
          where $1 = any(target_ids) order by recorded_at`,
        [observationId],
      ),
    );
    expect(acts.map((a) => a.action_type)).toEqual([
      'record_observation',
      'verify_record',
      'promote_observation',
    ]);
    expect(acts.map((a) => a.actor_id)).toEqual([noter.personId, f.reviewerId, f.reviewerId]);
  });
});
