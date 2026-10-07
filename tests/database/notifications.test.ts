/**
 * Notifications reach a person and carry nothing (ADR 0040 decision 9, KF-SAS-RQ-274;
 * KF-WAR-0006 OBL-004).
 *
 * The real notifier runs against a real database on the notifier's own login (`kf_notifier`, which
 * reads no table), and sends its digest through nodemailer to a real SMTP server on loopback — a
 * sink that keeps every message it is given — so the assertions are about what a mailbox received.
 * The urgent push is recorded at the point the notifier would run `alert-dispatch.sh urgent`;
 * tests/deployment/alert-dispatch.test.ts shows that script sends one fixed line and nothing else.
 *
 *   - a digest holds an internal record's title and a restricted record only as a count: no title,
 *     no identifier, no field of it;
 *   - a person with the digest off gets none, and a person with nothing waiting gets none;
 *   - only an urgent item pushes: an agent's submission (to be verified, not urgent) does not; a
 *     proposal waiting on the person does, exactly once; a person who turned the push off is not
 *     pushed.
 *
 * FALSIFIED at the end: with the database's ceiling check removed, the same digest carries the
 * restricted title — so the assertion that it does not is an assertion about that check.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionRequest } from '@kf/actions';
import { InMemoryObjectStore } from '@kf/artifacts';
import {
  createPool,
  issueAttestation,
  withTransaction,
  type Pool,
  type Principal,
} from '@kf/database';
import { PandocDocumentParser, createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { formObservationRequest } from '@kf/work-control';
import { runDeclareAgent } from '../../apps/api/src/admin/declare-agent.js';
import { runDigest, runUrgent } from '../../apps/notify/src/run.js';
import { parseSmtpSettings, smtpMailer } from '../../apps/notify/src/smtp.js';
import { bindContext, seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

const AGENT = 'notify-agent';
const RESTRICTED_TITLE = 'Acquisition target is Halberd Aero';
const INTERNAL_TITLE = 'Bench rail measured at 3.31 V under load';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createFabricDispatcher>;
let notifier: Pool;
let sink: Server;
let sinkPort = 0;
let stateDir: string;
/** Every message the SMTP sink accepted: envelope recipients and the raw DATA. */
const mailbox: { to: string[]; data: string }[] = [];
const log: Record<string, unknown>[] = [];

/**
 * The message as a reader sees it: headers, then the body with any quoted-printable or base64
 * transfer encoding undone, so a title split across encoded lines is still found — and a check
 * that a title is ABSENT cannot pass because the encoder happened to break it.
 */
function decoded(raw: string): string {
  const split = raw.indexOf('\n\n');
  const headers = raw.slice(0, split);
  const body = raw.slice(split + 2);
  if (/content-transfer-encoding:\s*quoted-printable/iu.test(headers)) {
    const bytes = body
      .replace(/=\n/gu, '')
      .replace(/=([0-9A-F]{2})/giu, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return `${headers}\n\n${Buffer.from(bytes, 'latin1').toString('utf8')}`;
  }
  if (/content-transfer-encoding:\s*base64/iu.test(headers)) {
    return `${headers}\n\n${Buffer.from(body.replace(/\s+/gu, ''), 'base64').toString('utf8')}`;
  }
  return raw;
}

/** A minimal SMTP server on loopback that keeps what it is given. */
function startSink(): Promise<void> {
  sink = createServer((socket: Socket) => {
    let buffer = '';
    let inData = false;
    let to: string[] = [];
    let data = '';
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 kf-test-sink ESMTP');
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mailbox.push({ to, data: decoded(data) });
            to = [];
            data = '';
            say('250 queued');
          } else {
            data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') say('250 kf-test-sink');
        else if (verb === 'MAIL') say('250 ok');
        else if (verb === 'RCPT') {
          to.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/iu, '$1'));
          say('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          say('354 go ahead');
        } else if (verb === 'QUIT') {
          say('221 bye');
          socket.end();
        } else if (verb === 'RSET' || verb === 'NOOP') say('250 ok');
        else say('502 not implemented');
      }
    });
  });
  return new Promise((resolve) =>
    sink.listen(0, '127.0.0.1', () => {
      sinkPort = (sink.address() as { port: number }).port;
      resolve();
    }),
  );
}

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

async function agentObservation(title: string, classification: string): Promise<string> {
  const request = formObservationRequest({
    organizationId: f.organizationId,
    actorId: f.performerId,
    liveAssignmentIds: [f.performerRoleId],
    gestureId: `notify-${randomUUID()}`,
    body: title,
    maxClassification: 'restricted',
  });
  const result = await execute({ ...request, attestation: await attest('performer', AGENT) });
  const id = result.objectIds[0]!;
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      'update core.object set classification = $2, title = $3, row_version = row_version + 1 where id = $1',
      [id, classification, title],
    );
  });
  return id;
}

const mailer = () =>
  smtpMailer(
    parseSmtpSettings(
      JSON.stringify({
        host: '127.0.0.1',
        port: sinkPort,
        security: 'none',
        from: 'kf@example.test',
      }),
    ),
  );

async function digestNow() {
  mailbox.length = 0;
  const m = mailer();
  try {
    return await runDigest(notifier, m, {
      webOrigin: 'https://kf.example.test',
      log: (entry) => log.push(entry),
    });
  } finally {
    m.close();
  }
}

const mailFor = (address: string) => mailbox.filter((mail) => mail.to.includes(address));

let restrictedId: string;
let internalId: string;
const pushes: number[] = [];

const urgentNow = (pushPerson = f.performerId) =>
  runUrgent(notifier, {
    stateDir,
    pushPerson,
    push: async () => {
      pushes.push(Date.now());
    },
    log: (entry) => log.push(entry),
  });

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
    reason: 'the agent whose submissions are notified',
    withdraw: false,
  });
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`update org.person set email = 'reviewer@example.test' where id = $1`, [
      f.reviewerId,
    ]);
    await tx.query(`update org.person set email = 'performer@example.test' where id = $1`, [
      f.performerId,
    ]);
    await tx.query(
      `create role kf_notify_login login password 'test-only-not-a-secret' in role kf_notifier`,
    );
  });
  const uri = new URL(h.connectionString);
  uri.username = 'kf_notify_login';
  uri.password = 'test-only-not-a-secret';
  notifier = createPool({ connectionString: uri.toString(), maxConnections: 2 });
  await startSink();
  stateDir = mkdtempSync(join(tmpdir(), 'kf-notify-'));

  internalId = await agentObservation(INTERNAL_TITLE, 'internal');
  restrictedId = await agentObservation(RESTRICTED_TITLE, 'restricted');
}, 240_000);

afterAll(async () => {
  await notifier?.end();
  await new Promise<void>((resolve) => (sink ? sink.close(() => resolve()) : resolve()));
  if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
  await h?.stop();
});

describe('the daily digest reaches a person and leaks nothing (OBL-004)', () => {
  it('is delivered over SMTP to the person’s address', async () => {
    const result = await digestNow();
    expect(result.failed).toBe(0);
    expect(mailFor('reviewer@example.test')).toHaveLength(1);
    expect(mailFor('performer@example.test')).toHaveLength(1);
  });

  it('names the internal record and gives the restricted one only as a count', async () => {
    await digestNow();
    for (const mail of mailbox) {
      expect(mail.data).not.toContain('Halberd');
      expect(mail.data).not.toContain(restrictedId);
    }
    const reviewer = mailFor('reviewer@example.test')[0]!.data;
    expect(reviewer).toContain(INTERNAL_TITLE);
    expect(reviewer).toContain(internalId);
    expect(reviewer).toMatch(/1 more item whose content stays in Knowledge Fabric/);
  });

  it('the log carries counts, never an address or a title', async () => {
    log.length = 0;
    await digestNow();
    expect(JSON.stringify(log)).not.toMatch(/@example\.test|Halberd|Bench/);
    expect(log[0]).toMatchObject({ run: 'digest', sent: 2, failed: 0 });
  });

  it('a person who turned the digest off gets none', async () => {
    await as('performer', undefined, {
      actionType: 'set_notification_preference',
      targetIds: [f.organizationId],
      payload: { digest: 'off', push: 'urgent' },
      idempotencyKey: `pref-${randomUUID()}`,
    });
    try {
      await digestNow();
      expect(mailFor('performer@example.test')).toHaveLength(0);
      expect(mailFor('reviewer@example.test')).toHaveLength(1);
    } finally {
      await as('performer', undefined, {
        actionType: 'set_notification_preference',
        targetIds: [f.organizationId],
        payload: { digest: 'daily', push: 'urgent' },
        idempotencyKey: `pref-${randomUUID()}`,
      });
    }
  });
});

describe('the push fires only for urgent items', () => {
  it('starts quiet, pushes nothing for a submission, and exactly once for a proposal', async () => {
    pushes.length = 0;
    expect(await urgentNow()).toMatchObject({ pushed: false }); // first run: the boundary
    await agentObservation('Another bench note', 'internal'); // waits to be verified: not urgent
    expect(await urgentNow()).toMatchObject({ pushed: false });
    expect(pushes).toHaveLength(0);

    const decision = await as('performer', undefined, {
      actionType: 'propose_decision',
      targetIds: [],
      payload: { title: 'Adopt the second-source capacitor' },
      idempotencyKey: `decision-${randomUUID()}`,
    });
    await as('performer', AGENT, {
      actionType: 'propose_act',
      targetIds: [decision.objectIds[0]!],
      payload: {
        action_type: 'accept_decision',
        target_ids: [decision.objectIds[0]!],
        payload: {},
        reason: 'the bench data supports it',
      },
      reason: 'proposed by an agent for its person: accept_decision',
      idempotencyKey: `propose-${randomUUID()}`,
    });
    expect(await urgentNow()).toMatchObject({ pushed: true, urgent: 1 });
    expect(pushes).toHaveLength(1);
    // The same item never pushes twice.
    expect(await urgentNow()).toMatchObject({ pushed: false });
    expect(pushes).toHaveLength(1);
  });

  it('a later item in the millisecond a run already reached still pushes, and a seen one never does', async () => {
    pushes.length = 0;
    expect(await urgentNow()).toMatchObject({ pushed: false });
    const decision = await as('performer', undefined, {
      actionType: 'propose_decision',
      targetIds: [],
      payload: { title: 'Requalify the reflow profile' },
      idempotencyKey: `decision-${randomUUID()}`,
    });
    await as('performer', AGENT, {
      actionType: 'propose_act',
      targetIds: [decision.objectIds[0]!],
      payload: {
        action_type: 'accept_decision',
        target_ids: [decision.objectIds[0]!],
        payload: {},
        reason: 'the profile drifted',
      },
      reason: 'proposed by an agent for its person: accept_decision',
      idempotencyKey: `propose-${randomUUID()}`,
    });
    const item = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ id: string; exact: string; millisecond: string; sub_millisecond: number }>(
        `select id,
                to_char(proposed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as exact,
                to_char(date_trunc('milliseconds', proposed_at) at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as millisecond,
                extract(microseconds from proposed_at)::int % 1000 as sub_millisecond
           from core.act_proposal order by proposed_at desc, id desc limit 1`,
      ),
    );
    // The run before reached this millisecond through an earlier item in it (a boundary at the
    // millisecond, as a JavaScript instant would have kept it). The new item is later within it.
    expect(item.sub_millisecond, 'the item fell exactly on a millisecond; rerun').toBeGreaterThan(
      0,
    );
    writeFileSync(join(stateDir, 'urgent-since'), `${item.millisecond}\n`);
    expect(await urgentNow()).toMatchObject({ pushed: true, urgent: 1 });
    expect(pushes).toHaveLength(1);
    // The boundary is now the item itself, to the microsecond and by id: it is never pushed again.
    writeFileSync(
      join(stateDir, 'urgent-since'),
      JSON.stringify({ at: item.exact, item: item.id }),
    );
    expect(await urgentNow()).toMatchObject({ pushed: false });
    expect(pushes).toHaveLength(1);
  });

  it('a person who turned the push off is not pushed, and someone else’s item does not push', async () => {
    pushes.length = 0;
    await as('performer', undefined, {
      actionType: 'set_notification_preference',
      targetIds: [f.organizationId],
      payload: { digest: 'daily', push: 'off' },
      idempotencyKey: `pref-${randomUUID()}`,
    });
    const decision = await as('performer', undefined, {
      actionType: 'propose_decision',
      targetIds: [],
      payload: { title: 'Move the bench to building B' },
      idempotencyKey: `decision-${randomUUID()}`,
    });
    await as('performer', AGENT, {
      actionType: 'propose_act',
      targetIds: [decision.objectIds[0]!],
      payload: {
        action_type: 'accept_decision',
        target_ids: [decision.objectIds[0]!],
        payload: {},
        reason: 'the move is agreed',
      },
      reason: 'proposed by an agent for its person: accept_decision',
      idempotencyKey: `propose-${randomUUID()}`,
    });
    expect(await urgentNow()).toMatchObject({ pushed: false });
    expect(await urgentNow(f.reviewerId)).toMatchObject({ pushed: false });
    expect(pushes).toHaveLength(0);
  });
});

describe('falsified', () => {
  it('without the database’s ceiling check, the restricted title reaches the mailbox', async () => {
    await withTransaction(h.adminPool, (tx) =>
      tx.query(
        `alter function core.may_leave_host(uuid, text) rename to may_leave_host_real;
         create function core.may_leave_host(p_organization uuid, p_classification text)
           returns boolean language sql stable as $$ select true $$`,
      ),
    );
    try {
      await digestNow();
      expect(mailFor('reviewer@example.test')[0]!.data).toContain('Halberd');
    } finally {
      await withTransaction(h.adminPool, (tx) =>
        tx.query(
          `drop function core.may_leave_host(uuid, text);
           alter function core.may_leave_host_real(uuid, text) rename to may_leave_host`,
        ),
      );
    }
    await digestNow();
    expect(mailFor('reviewer@example.test')[0]!.data).not.toContain('Halberd');
  });
});
