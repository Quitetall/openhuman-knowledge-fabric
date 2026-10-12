/**
 * The urgent push reaches each person, and only what they may see (ADR 0040 decision 9,
 * KF-SAS-RQ-274; 20261011500000; SAS §100.57).
 *
 * The real notifier runs against a real database on the notifier's own login (`kf_notifier`), and
 * pushes to a fake ntfy server on loopback that keeps every message and echoes it as ntfy does, so
 * the assertions are about what a phone would have received. Nothing is sent to a real server.
 *
 *   - a destination is set by the person's own act, through the gesture that seals it: never
 *     readable by anyone else, never an agent's, never a plaintext URL — not in the table and not
 *     in the ledger (KF-NOTIFY-001, -003, -004);
 *   - each urgent item reaches each person entitled to see it NOW, once: an item whose records the
 *     person cannot read is never pushed to them; a title only at or below the provider ceiling;
 *     a failed push is retried for that person alone, and nothing is pushed twice;
 *   - a person with no destination is told by the digest, and KF_NOTIFY_PUSH_PERSON still reaches
 *     the alert path.
 *
 * FALSIFIED at the end: each guard removed, the forbidden thing happens.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionRejected, appendAuditEvent, type ActionRequest } from '@kf/actions';
import { InMemoryObjectStore } from '@kf/artifacts';
import { destinationOpener, generateDestinationKey } from '@kf/authorization';
import {
  createPool,
  issueAttestation,
  withTransaction,
  type Pool,
  type Principal,
  type Tx,
} from '@kf/database';
import { PandocDocumentParser, createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { runDeclareAgent } from '../../apps/api/src/admin/declare-agent.js';
import type { Caller } from '../../apps/api/src/routes/actions/contracts.js';
import { setPushDestination } from '../../apps/api/src/routes/agent-settings.js';
import { ntfySender, UNDISCLOSED_PUSH } from '../../apps/notify/src/push.js';
import { runUrgent, UrgentDeliveryFailed } from '../../apps/notify/src/run.js';
import {
  bindContext,
  bindReader,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

const AGENT = 'push-agent';
const RESTRICTED_TITLE = 'Acquisition target is Halberd Aero';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createFabricDispatcher>;
let notifier: Pool;
let ntfy: Server;
let server = '';
let stateDir: string;
let failNext = 0;
/** Every message the fake ntfy server accepted, by topic. */
const phone: { topic: string; title: string | undefined; body: string }[] = [];
const alertPath: number[] = [];
const log: Record<string, unknown>[] = [];

const key = generateDestinationKey();
const performerTopic = `kf-perf-${randomUUID().replaceAll('-', '')}`;
const reviewerTopic = `kf-rev-${randomUUID().replaceAll('-', '')}`;

const principal = (who: 'performer' | 'reviewer'): Principal => ({
  actorId: who === 'performer' ? f.performerId : f.reviewerId,
  actingRoleId: who === 'performer' ? f.performerRoleId : f.reviewerRoleId,
  organizationId: f.organizationId,
  maxClassification: 'restricted',
});

const attest = (who: 'performer' | 'reviewer', agent?: string) =>
  withTransaction(h.attestorPool, (tx) =>
    issueAttestation(
      tx,
      principal(who),
      undefined,
      agent === undefined
        ? { authorizedParty: 'knowledge-fabric-web' }
        : { agentClientId: agent, authorizedParty: agent },
    ),
  );

async function as(
  who: 'performer' | 'reviewer',
  agent: string | undefined,
  request: Omit<
    ActionRequest,
    'actorId' | 'actingRoleId' | 'organizationId' | 'maxClassification' | 'attestation'
  >,
) {
  return execute({ ...request, ...principal(who), attestation: await attest(who, agent) });
}

async function caller(who: 'performer' | 'reviewer', agent?: string): Promise<Caller> {
  return {
    ...principal(who),
    authentication: {},
    attestation: await attest(who, agent),
  } as Caller;
}

const config = () => ({ publicKey: key.publicKey, servers: [server] });

const setDestination = async (
  who: 'performer' | 'reviewer',
  destination: string | null,
  agent?: string,
) => setPushDestination(execute, await caller(who, agent), destination, config());

async function refusal(promise: Promise<unknown>): Promise<ActionRejected> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ActionRejected) return error;
    throw error;
  }
  throw new Error('expected a refusal; the act was applied');
}

/** A decision the person created, at `classification`, and their agent's proposal to accept it. */
async function proposalFor(
  who: 'performer' | 'reviewer',
  title: string,
  classification = 'internal',
): Promise<string> {
  const decision = await as(who, undefined, {
    actionType: 'propose_decision',
    targetIds: [],
    payload: { title },
    idempotencyKey: `decision-${randomUUID()}`,
  });
  const id = decision.objectIds[0]!;
  if (classification !== 'internal') {
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `update core.object set classification = $2, row_version = row_version + 1 where id = $1`,
        [id, classification],
      );
    });
  }
  await as(who, AGENT, {
    actionType: 'propose_act',
    targetIds: [id],
    payload: { action_type: 'accept_decision', target_ids: [id], payload: {}, reason: 'agreed' },
    reason: 'proposed by an agent for its person: accept_decision',
    idempotencyKey: `propose-${randomUUID()}`,
  });
  return id;
}

/**
 * Bind `who` and record an act of `actionType` by them in this transaction, as the dispatcher
 * would, so a direct write is held to exactly what that act's own effect is held to.
 */
async function underAct(tx: Tx, who: 'performer' | 'reviewer', actionType: string) {
  const { actorId, actingRoleId } = principal(who);
  await bindReader(tx, f, actorId);
  const actionId = randomUUID();
  await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
    actorId,
    actingRoleId,
    actionId,
    'push-destination-test',
  ]);
  const { effective_at: effectiveAt } = await tx.one<{ effective_at: Date }>(
    "select date_trunc('milliseconds', now() + interval '999 microseconds') as effective_at",
  );
  await tx.query(
    `insert into core.action
       (id, organization_id, request_digest, action_type, actor_id, acting_role_id, target_ids,
        idempotency_key, effective_at, reason, result_status)
     values ($1::uuid, $2::uuid,
             encode(sha256(convert_to('push-destination-test:' || $1::text, 'UTF8')), 'hex'),
             $3, $4::uuid, $5::uuid, array[$2::uuid], 'push-destination-test-' || $1::text,
             $6, 'push destination test', 'applied')`,
    [actionId, f.organizationId, actionType, actorId, actingRoleId, effectiveAt],
  );
  await appendAuditEvent(tx, {
    actionId,
    actionType,
    actorId,
    actingRoleId,
    objectIds: [f.organizationId],
    effectiveAt,
    reason: 'push destination test',
    beforeDigest: null,
    afterDigest: null,
  });
  return actionId;
}

/** The reviewer, under their own set_push_destination act, writes a row naming the performer. */
const reviewerWritesPerformersRow = (sealed: string) =>
  withTransaction(h.pool, async (tx) => {
    const actionId = await underAct(tx, 'reviewer', 'set_push_destination');
    await tx.query(
      `insert into core.push_destination (organization_id, person_id, sealed, set_by_action)
       values ($1, $2, $3, $4)`,
      [f.organizationId, f.performerId, sealed, actionId],
    );
  });

const latestSealed = (person: string) =>
  withTransaction(h.adminPool, (tx) =>
    tx.maybeOne<{ sealed: string | null }>(
      `select sealed from core.push_destination where person_id = $1
        order by revision desc limit 1`,
      [person],
    ),
  );

const urgentNow = (options: { pushPerson?: string; withKey?: boolean } = {}) =>
  runUrgent(notifier, {
    stateDir,
    pushPerson: options.pushPerson,
    push: async () => {
      alertPath.push(Date.now());
    },
    ...(options.withKey === false
      ? {}
      : { opener: destinationOpener(key.privatePem), send: ntfySender([server]) }),
    webOrigin: 'https://kf.example.test',
    log: (entry) => log.push(entry),
  });

const to = (topic: string) => phone.filter((message) => message.topic === topic);

const clearance = (person: string, level: string) =>
  withTransaction(h.adminPool, (tx) =>
    tx.query(
      `update org.person_clearance set max_classification = $3
        where subject_id = $1 and organization_id = $2`,
      [person, f.organizationId, level],
    ),
  );

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  execute = createFabricDispatcher(
    h.pool,
    createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: new PandocDocumentParser(),
    }),
  );
  await runDeclareAgent(h.adminPool, {
    clientId: AGENT,
    declaredBy: f.reviewerId,
    reason: 'the agent whose proposals are pushed',
    withdraw: false,
  });
  await withTransaction(h.adminPool, (tx) =>
    tx.query(
      `create role kf_push_login login password 'test-only-not-a-secret' in role kf_notifier`,
    ),
  );
  const uri = new URL(h.connectionString);
  uri.username = 'kf_push_login';
  uri.password = 'test-only-not-a-secret';
  notifier = createPool({ connectionString: uri.toString(), maxConnections: 2 });

  ntfy = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      if (failNext > 0) {
        failNext -= 1;
        response.writeHead(503).end();
        return;
      }
      phone.push({
        topic: (request.url ?? '').slice(1),
        title: request.headers['title'] as string | undefined,
        body,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ event: 'message', message: body }));
    });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
  server = `http://127.0.0.1:${String((ntfy.address() as { port: number }).port)}`;
  stateDir = mkdtempSync(join(tmpdir(), 'kf-push-'));
}, 600_000);

afterAll(async () => {
  await notifier?.end();
  await new Promise<void>((resolve) => (ntfy ? ntfy.close(() => resolve()) : resolve()));
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
  await h?.stop();
});

describe('a destination is the person’s own, and sealed', () => {
  it('is set through the gesture that seals it, and the URL is nowhere in the database', async () => {
    const set = await setDestination('performer', `${server}/${performerTopic}`);
    expect(set.receipt).toMatchObject({ destinationSet: true });
    const found = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ n: string }>(
        `select (select count(*) from core.action where parameters::text like '%' || $1 || '%')
              + (select count(*) from core.push_destination where sealed like '%' || $1 || '%')
              + (select count(*) from core.audit_event where coalesce(reason, '') like '%' || $1 || '%')
                as n`,
        [performerTopic],
      ),
    );
    expect(found.n).toBe('0');
    const ledger = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ destination: string }>(
        `select parameters ->> 'destination' as destination from core.action
          where action_type = 'set_push_destination' order by recorded_at desc limit 1`,
      ),
    );
    expect(ledger.destination).toMatch(/^kfpd1\./);
  });

  it('is read by nobody but its person', async () => {
    const own = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId);
      return tx.query<{ person_id: string }>('select person_id from core.push_destination');
    });
    expect(own.map((row) => row.person_id)).toEqual([f.performerId]);
    const others = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.reviewerId);
      return tx.query('select 1 from core.push_destination where person_id = $1', [f.performerId]);
    });
    expect(others).toHaveLength(0);
    await expect(
      withTransaction(notifier, (tx) => tx.query('select sealed from core.push_destination')),
    ).rejects.toThrow(/permission denied/);
  });

  it('is never set for someone else: a row naming another person lands as the writer’s', async () => {
    const mine = (await latestSealed(f.performerId))!.sealed!;
    // Someone else's sealed value, written by the reviewer's own act, naming the performer.
    await reviewerWritesPerformersRow(mine);
    expect((await latestSealed(f.performerId))!.sealed).toBe(mine);
    const theirs = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ person_id: string }>(
        `select person_id from core.push_destination order by revision desc limit 1`,
      ),
    );
    expect(theirs[0]!.person_id).toBe(f.reviewerId);
    // And it does not open for them: the seal is bound to the person it was made for.
    expect(
      destinationOpener(key.privatePem).open(mine, {
        organizationId: f.organizationId,
        personId: f.reviewerId,
      }),
    ).toBeUndefined();
    await setDestination('reviewer', `${server}/${reviewerTopic}`);
  });

  it('is never set by an agent acting for the person (KF-NOTIFY-001)', async () => {
    await expect(setDestination('performer', `${server}/${'a'.repeat(32)}`, AGENT)).rejects.toThrow(
      /KF-NOTIFY-001/,
    );
  });

  it('is refused as a plaintext URL before anything is recorded (KF-NOTIFY-004)', async () => {
    const plaintext = `${server}/${performerTopic}x`;
    const refused = await refusal(
      as('performer', undefined, {
        actionType: 'set_push_destination',
        targetIds: [f.organizationId],
        payload: { destination: plaintext },
        idempotencyKey: `destination-${randomUUID()}`,
      }),
    );
    expect(refused.message).toMatch(/KF-NOTIFY-004/);
    expect(refused.message).not.toContain(performerTopic);
    const recorded = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ n: string }>(
        `select count(*)::text as n from core.action where parameters::text like '%' || $1 || '%'`,
        [`${performerTopic}x`],
      ),
    );
    expect(recorded.n).toBe('0');
    // And by the database in every session, an administrator's included.
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f, f.performerId);
        await tx.query(
          `insert into core.push_destination (organization_id, person_id, sealed, set_by_action)
           values ($1, $2, $3, $4)`,
          [f.organizationId, f.performerId, plaintext, f.clearanceActionId],
        );
      }),
    ).rejects.toThrow(/KF-NOTIFY-004/);
  });

  it('is written only by its own act (KF-NOTIFY-003)', async () => {
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindContext(tx, f, f.performerId);
        await tx.query(
          `insert into core.push_destination (organization_id, person_id, sealed, set_by_action)
           values ($1, $2, null, core.current_action_id())`,
          [f.organizationId, f.performerId],
        );
      }),
    ).rejects.toThrow(/KF-NOTIFY-003/);
  });
});

describe('each urgent item reaches each person entitled to see it, once', () => {
  it('pushes a proposal to its person’s own topic, named, exactly once', async () => {
    expect(await urgentNow()).toMatchObject({ pushed: false }); // first run: the boundary
    phone.length = 0;
    await proposalFor('performer', 'Adopt the second-source capacitor');
    expect(await urgentNow()).toMatchObject({ pushed: true, urgent: 1 });
    expect(to(performerTopic)).toEqual([
      {
        topic: performerTopic,
        title: 'Knowledge Fabric',
        body: 'Needs you: accept_decision: Adopt the second-source capacitor',
      },
    ]);
    expect(to(reviewerTopic)).toHaveLength(0);
    expect(await urgentNow()).toMatchObject({ pushed: false });
    expect(phone).toHaveLength(1);
  });

  it('pushes an item above the provider ceiling without its title', async () => {
    phone.length = 0;
    await proposalFor('performer', RESTRICTED_TITLE, 'restricted');
    await urgentNow();
    expect(to(performerTopic).map((message) => message.body)).toEqual([UNDISCLOSED_PUSH]);
    expect(JSON.stringify(phone)).not.toContain('Halberd');
  });

  it('never pushes an item the person cannot read now', async () => {
    phone.length = 0;
    await proposalFor('performer', 'Requalify the reflow profile', 'confidential');
    await clearance(f.performerId, 'internal');
    try {
      expect(await urgentNow()).toMatchObject({ pushed: false });
      expect(phone).toHaveLength(0);
    } finally {
      await clearance(f.performerId, 'restricted');
    }
    // Entitlement is decided at send time: readable again, the item reaches them, untitled
    // because it is above the ceiling.
    expect(await urgentNow()).toMatchObject({ pushed: true, urgent: 1 });
    expect(to(performerTopic).map((m) => m.body)).toEqual([UNDISCLOSED_PUSH]);
  });

  it('retries a failed push for that person alone, and never repeats one delivered', async () => {
    phone.length = 0;
    await proposalFor('performer', 'Move the bench to building B');
    await proposalFor('reviewer', 'Order a second oscilloscope');
    // The first request of the run fails: the performer's (items are ordered by when they arose).
    failNext = 1;
    await expect(urgentNow()).rejects.toBeInstanceOf(UrgentDeliveryFailed);
    expect(to(performerTopic)).toHaveLength(0);
    expect(to(reviewerTopic).map((m) => m.body)).toEqual([
      'Needs you: accept_decision: Order a second oscilloscope',
    ]);
    expect(await urgentNow()).toMatchObject({ pushed: true, urgent: 1 });
    expect(to(performerTopic).map((m) => m.body)).toEqual([
      'Needs you: accept_decision: Move the bench to building B',
    ]);
    expect(to(reviewerTopic)).toHaveLength(1);
    expect(await urgentNow()).toMatchObject({ pushed: false });
    expect(phone).toHaveLength(2);
    expect(JSON.stringify(log)).not.toContain(performerTopic);
    expect(JSON.stringify(log)).not.toMatch(/Halberd|oscilloscope|kfpd1/);
  });

  it('tells a person with no destination by the digest, and KF_NOTIFY_PUSH_PERSON by the alert path', async () => {
    await setDestination('reviewer', null);
    phone.length = 0;
    alertPath.length = 0;
    log.length = 0;
    await proposalFor('reviewer', 'Recalibrate the bench supply');
    expect(await urgentNow()).toMatchObject({ pushed: false });
    expect(log.at(-1)).toMatchObject({ withoutPush: 1, delivered: 0 });
    await proposalFor('reviewer', 'Replace the thermal chamber seal');
    expect(await urgentNow({ pushPerson: f.reviewerId })).toMatchObject({
      pushed: true,
      urgent: 1,
    });
    expect(alertPath).toHaveLength(1);
    expect(phone).toHaveLength(0);
  });

  it('without the notifier’s key, a destination is unused and the person is told by the digest', async () => {
    phone.length = 0;
    log.length = 0;
    await proposalFor('performer', 'Retire the old fixture');
    expect(await urgentNow({ withKey: false })).toMatchObject({ pushed: false });
    expect(phone).toHaveLength(0);
    expect(log.at(-1)).toMatchObject({ withoutPush: 1 });
  });
});

describe('falsified', () => {
  async function without(ddl: string, body: () => Promise<void>): Promise<void> {
    await withTransaction(h.adminPool, (tx) => tx.query(ddl.split('||')[0]!));
    try {
      await body();
    } finally {
      await withTransaction(h.adminPool, (tx) => tx.query(ddl.split('||')[1]!));
    }
  }

  it('without the ceiling check, the restricted title reaches the phone', async () => {
    phone.length = 0;
    await without(
      `alter function core.may_leave_host(uuid, text) rename to may_leave_host_real;
       create function core.may_leave_host(p_organization uuid, p_classification text)
         returns boolean language sql stable as $$ select true $$||` +
        `drop function core.may_leave_host(uuid, text);
         alter function core.may_leave_host_real(uuid, text) rename to may_leave_host`,
      async () => {
        await proposalFor('performer', `${RESTRICTED_TITLE} (2)`, 'restricted');
        await urgentNow();
        expect(JSON.stringify(to(performerTopic))).toContain('Halberd');
      },
    );
  });

  it('without the read check, an item the person cannot read is pushed to them', async () => {
    phone.length = 0;
    await proposalFor('performer', 'Close the second site', 'confidential');
    await clearance(f.performerId, 'internal');
    try {
      await without(
        `alter function core.notification_person_reads(uuid, uuid, uuid, text)
           rename to notification_person_reads_real;
         create function core.notification_person_reads(
           p_person uuid, p_organization uuid, p_object uuid, p_classification text)
           returns boolean language sql stable as $$ select true $$||` +
          `drop function core.notification_person_reads(uuid, uuid, uuid, text);
           alter function core.notification_person_reads_real(uuid, uuid, uuid, text)
             rename to notification_person_reads`,
        async () => {
          expect(await urgentNow()).toMatchObject({ pushed: true, urgent: 1 });
        },
      );
    } finally {
      await clearance(f.performerId, 'restricted');
    }
  });

  it('without the cursor, a delivered item is pushed again', async () => {
    phone.length = 0;
    const before = new Date(Date.now() - 1000).toISOString().replace('Z', '000Z');
    await proposalFor('performer', 'Archive the 2025 calibration set');
    await urgentNow();
    expect(to(performerTopic)).toHaveLength(1);
    writeFileSync(join(stateDir, 'urgent-since'), `${before}\n`);
    await urgentNow();
    expect(to(performerTopic).length).toBeGreaterThan(1);
  });

  it('without the destination bound, an agent sets its person’s destination', async () => {
    await without(
      'drop trigger push_destination_bounded on core.push_destination||' +
        'create trigger push_destination_bounded before insert or update or delete on ' +
        'core.push_destination for each row execute function core.push_destination_bounded()',
      async () => {
        const set = await setDestination('performer', `${server}/${'b'.repeat(32)}`, AGENT);
        expect(set.receipt).toMatchObject({ destinationSet: true });
      },
    );
    await setDestination('performer', `${server}/${performerTopic}`);
  });

  it('without the bound and the insert policy’s person check, someone else sets my destination', async () => {
    const theirs = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ sealed: string }>(
        `select sealed from core.push_destination where person_id = $1
          order by revision desc limit 1`,
        [f.reviewerId],
      ),
    );
    await without(
      `drop trigger push_destination_bounded on core.push_destination;
       drop policy push_destination_insert on core.push_destination;
       create policy push_destination_insert on core.push_destination for insert
         with check (organization_id = (select core.current_organization()))||` +
        `drop policy push_destination_insert on core.push_destination;
         create policy push_destination_insert on core.push_destination for insert
           with check (
             organization_id = (select core.current_organization())
             and person_id = (select core.current_actor_or_null())
             and set_by_action = (select core.current_action_id()));
         create trigger push_destination_bounded before insert or update or delete on
           core.push_destination for each row execute function core.push_destination_bounded()`,
      async () => {
        await reviewerWritesPerformersRow(theirs.sealed);
        expect((await latestSealed(f.performerId))!.sealed).toBe(theirs.sealed);
      },
    );
    await setDestination('performer', `${server}/${performerTopic}`);
  });

  it('without the bound and the check, a plaintext URL is stored', async () => {
    const plaintext = `${server}/${performerTopic}`;
    await without(
      `drop trigger push_destination_bounded on core.push_destination;
       alter table core.push_destination drop constraint push_destination_sealed_check||` +
        `delete from core.push_destination where sealed not like 'kfpd1.%';
         alter table core.push_destination add constraint push_destination_sealed_check check (
           sealed is null or sealed ~
             '^kfpd1\\.[0-9a-f]{16}\\.[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{22,}$'
             and length(sealed) <= 788);
         create trigger push_destination_bounded before insert or update or delete on
           core.push_destination for each row execute function core.push_destination_bounded()`,
      async () => {
        await withTransaction(h.adminPool, async (tx) => {
          await bindContext(tx, f, f.performerId);
          await tx.query(
            `insert into core.push_destination (organization_id, person_id, sealed, set_by_action)
             values ($1, $2, $3, $4)`,
            [f.organizationId, f.performerId, plaintext, f.clearanceActionId],
          );
        });
        expect((await latestSealed(f.performerId))!.sealed).toBe(plaintext);
      },
    );
    expect((await latestSealed(f.performerId))!.sealed).toMatch(/^kfpd1\./);
  });
});
