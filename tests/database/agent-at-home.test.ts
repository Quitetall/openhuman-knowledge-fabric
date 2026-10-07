/**
 * The agent at home — in the database (ADR 0040 decisions 8 and 9, KF-SAS-RQ-271, RQ-274;
 * 20261007300000).
 *
 * Every act goes through the real fabric dispatcher on the application login, bound on an
 * attestation issued through the attestor's login, as in agents-as-colleagues.test.ts. What must
 * hold:
 *
 *   - what may leave the host is an organization's institutional decision, recorded by its act,
 *     and never `confidential` or `restricted`, in any session (KF-ROUTE-001, KF-ROUTE-002);
 *   - a notification setting is the performing person's own and never an agent's (KF-NOTIFY-001,
 *     KF-NOTIFY-002), and nobody else reads it;
 *   - the notifier's login reads no table, and what it is given for a digest is exactly what Needs
 *     you lists for each person, with a title and an identifier only at or below the ceiling;
 *   - an urgent push is derived from proposals waiting on a person, and honours their setting.
 *
 * Each guard is FALSIFIED in the last block: removed, the forbidden thing happens.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionRejected, type ActionRequest } from '@kf/actions';
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
import { needsYou } from '../../apps/api/src/routes/needs-you.js';
import {
  bindContext,
  bindReader,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

const AGENT = 'home-agent';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createFabricDispatcher>;
let notifier: Pool;

const principal = (who: 'performer' | 'reviewer'): Principal => ({
  actorId: who === 'performer' ? f.performerId : f.reviewerId,
  actingRoleId: who === 'performer' ? f.performerRoleId : f.reviewerRoleId,
  organizationId: f.organizationId,
  maxClassification: 'restricted',
});

const attest = (who: 'performer' | 'reviewer', agent?: string): Promise<string> =>
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

async function refusal(promise: Promise<unknown>): Promise<ActionRejected> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ActionRejected) return error;
    throw error;
  }
  throw new Error('expected a refusal; the act was applied');
}

const setCeiling = (ceiling: string, agent?: string) =>
  as('reviewer', agent, {
    actionType: 'set_model_routing_policy',
    targetIds: [f.organizationId],
    payload: { provider_ceiling: ceiling },
    reason: `the organization lets ${ceiling} content leave the host`,
    idempotencyKey: `routing-${randomUUID()}`,
  });

const setPreference = (
  who: 'performer' | 'reviewer',
  setting: { digest?: string; push?: string },
  agent?: string,
) =>
  as(who, agent, {
    actionType: 'set_notification_preference',
    targetIds: [f.organizationId],
    payload: setting,
    idempotencyKey: `preference-${randomUUID()}`,
  });

/** An observation the performer's agent captured, at `classification`, titled `title`. */
async function agentObservation(title: string, classification: string): Promise<string> {
  const request = formObservationRequest({
    organizationId: f.organizationId,
    actorId: f.performerId,
    liveAssignmentIds: [f.performerRoleId],
    gestureId: `home-${randomUUID()}`,
    body: title,
    maxClassification: 'restricted',
  });
  const result = await execute({ ...request, attestation: await attest('performer', AGENT) });
  const id = result.objectIds[0]!;
  await withTransaction(h.adminPool, async (tx) => {
    await bindContext(tx, f);
    await tx.query(
      `update core.object set classification = $2, title = $3, row_version = row_version + 1
        where id = $1`,
      [id, classification, title],
    );
  });
  return id;
}

interface DigestRow extends Record<string, unknown> {
  organization_id: string;
  organization_name: string | null;
  person_id: string;
  email: string;
  kind: string;
  disclosed: boolean;
  item_id: string | null;
  title: string | null;
}

const digest = (pool: Pool = notifier) =>
  withTransaction(pool, (tx) => tx.query<DigestRow>('select * from core.needs_you_digest()'));

const digestFor = async (personId: string) =>
  (await digest()).filter(
    (row) => row.person_id === personId && row.organization_id === f.organizationId,
  );

let internalId: string;
let restrictedId: string;
const RESTRICTED_TITLE = 'Restricted: the acquisition target is Halberd Aero';
const INTERNAL_TITLE = 'Internal: bench rail measured at 3.31 V';

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
    reason: 'the in-app agent under test',
    withdraw: false,
  });
  // Contact details, as a person record holds them.
  await withTransaction(h.adminPool, async (tx) => {
    await tx.query(`update org.person set email = 'reviewer@example.test' where id = $1`, [
      f.reviewerId,
    ]);
    await tx.query(`update org.person set email = 'performer@example.test' where id = $1`, [
      f.performerId,
    ]);
    // The notifier's login: kf_notifier and nothing else, as kf-notify connects.
    await tx.query(
      `create role kf_notify_test login password 'test-only-not-a-secret' in role kf_notifier`,
    );
  });
  const uri = new URL(h.connectionString);
  uri.username = 'kf_notify_test';
  uri.password = 'test-only-not-a-secret';
  notifier = createPool({ connectionString: uri.toString(), maxConnections: 2 });

  internalId = await agentObservation(INTERNAL_TITLE, 'internal');
  restrictedId = await agentObservation(RESTRICTED_TITLE, 'restricted');
}, 240_000);

afterAll(async () => {
  await notifier?.end();
  await h?.stop();
});

describe('what may leave the host is the organization’s act (KF-SAS-RQ-271)', () => {
  it('is recorded by set_model_routing_policy, and the latest is in force', async () => {
    const set = await setCeiling('public');
    expect(set.receipt).toMatchObject({ providerCeiling: 'public' });
    const inForce = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId);
      return tx.one<{ ceiling: string }>('select core.provider_ceiling_in_force($1) as ceiling', [
        f.organizationId,
      ]);
    });
    expect(inForce.ceiling).toBe('public');
    await setCeiling('internal');
  });

  it('is never confidential or restricted: the act and the database refuse it', async () => {
    for (const ceiling of ['confidential', 'restricted']) {
      const refused = await refusal(setCeiling(ceiling));
      expect(refused.message).toMatch(/KF-ROUTE-001/);
    }
    // Not even the owner, nor a restore: ADR 0040 decision 8 is not an organization's to change.
    await expect(
      withTransaction(h.adminPool, (tx) =>
        tx.query(
          `insert into core.model_routing_policy
             (organization_id, provider_ceiling, reason, set_by, set_by_action)
           values ($1, 'restricted', 'an owner widening the ceiling', $2, gen_random_uuid())`,
          [f.organizationId, f.reviewerId],
        ),
      ),
    ).rejects.toThrow(/KF-ROUTE-001/);
  });

  it('is never an agent’s: the act is institutional (KF-AGENT-001)', async () => {
    const refused = await refusal(setCeiling('internal', AGENT));
    expect(refused.detail['rule']).toBe('KF-AGENT-001');
  });

  it('is written only by its own act (KF-ROUTE-002)', async () => {
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindContext(tx, f, f.reviewerId);
        await tx.query(
          `insert into core.model_routing_policy
             (organization_id, provider_ceiling, reason, set_by, set_by_action)
           values ($1, 'internal', 'widening outside the act', $2, core.current_action_id())`,
          [f.organizationId, f.reviewerId],
        );
      }),
    ).rejects.toThrow(/KF-ROUTE-002/);
  });
});

describe('a notification setting is the person’s own (KF-SAS-RQ-274)', () => {
  it('records the performing person, and only they read it', async () => {
    await setPreference('performer', { digest: 'daily', push: 'urgent' });
    const own = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId);
      return tx.query<{ person_id: string }>('select person_id from core.notification_preference');
    });
    expect(own.map((row) => row.person_id)).toEqual([f.performerId]);
    const others = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.reviewerId);
      return tx.query('select 1 from core.notification_preference where person_id = $1', [
        f.performerId,
      ]);
    });
    expect(others).toHaveLength(0);
  });

  it('is never set by an agent acting for them (KF-NOTIFY-001)', async () => {
    await expect(setPreference('performer', { digest: 'off' }, AGENT)).rejects.toThrow(
      /KF-NOTIFY-001/,
    );
  });

  it('is written only by its own act (KF-NOTIFY-002)', async () => {
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindContext(tx, f, f.performerId);
        await tx.query(
          `insert into core.notification_preference
             (organization_id, person_id, digest, push, set_by_action)
           values ($1, $2, 'off', 'off', core.current_action_id())`,
          [f.organizationId, f.performerId],
        );
      }),
    ).rejects.toThrow(/KF-NOTIFY-002/);
  });
});

describe('the digest is Needs you, redacted for a channel the deployment does not control', () => {
  it('the notifier’s login reads no table', async () => {
    await expect(
      withTransaction(notifier, (tx) => tx.query('select title from core.object limit 1')),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTransaction(notifier, (tx) => tx.query('select email from org.person limit 1')),
    ).rejects.toThrow(/permission denied/);
  });

  it('lists what Needs you lists for each person, no more and no fewer', async () => {
    for (const who of ['reviewer', 'performer'] as const) {
      const p = principal(who);
      const listed = await withTransaction(h.pool, async (tx) => {
        await bindReader(tx, f, p.actorId);
        return needsYou(tx, { ...p, authentication: {} } as never);
      });
      const expected =
        who === 'reviewer'
          ? listed.toVerify.items.map((item) => item.id)
          : listed.awaitingOthers.items.map((item) => item.id);
      const rows = (await digestFor(p.actorId)).filter((row) => row.kind !== 'proposal');
      expect(rows.length, `${who}: one digest row per Needs-you item`).toBe(expected.length);
      expect(expected).toEqual(expect.arrayContaining([internalId, restrictedId]));
      expect(
        rows.every((row) => row.kind === (who === 'reviewer' ? 'to_verify' : 'awaiting_others')),
      ).toBe(true);
      // Every disclosed identifier is one Needs you listed.
      for (const row of rows.filter((r) => r.disclosed)) expect(expected).toContain(row.item_id);
    }
  });

  it('names an internal record and gives a restricted one as a bare count', async () => {
    const rows = await digestFor(f.reviewerId);
    const internal = rows.find((row) => row.item_id === internalId);
    expect(internal).toMatchObject({ disclosed: true, title: INTERNAL_TITLE });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(restrictedId);
    expect(serialized).not.toContain('Halberd');
    expect(
      rows.filter((row) => !row.disclosed && row.item_id === null && row.title === null),
    ).not.toHaveLength(0);
  });

  it('follows the organization’s ceiling: under `public` an internal title stays on the host', async () => {
    await setCeiling('public');
    try {
      const rows = await digestFor(f.reviewerId);
      expect(JSON.stringify(rows)).not.toContain(INTERNAL_TITLE);
      expect(rows.some((row) => row.disclosed)).toBe(false);
    } finally {
      await setCeiling('internal');
    }
  });

  it('leaves out a person who turned the digest off', async () => {
    await setPreference('performer', { digest: 'off', push: 'urgent' });
    try {
      expect(await digestFor(f.performerId)).toHaveLength(0);
      expect((await digestFor(f.reviewerId)).length).toBeGreaterThan(0);
    } finally {
      await setPreference('performer', { digest: 'daily', push: 'urgent' });
    }
  });
});

describe('an urgent push is derived from what waits on a person', () => {
  it('a proposal waiting on the person is urgent, once, and their setting silences it', async () => {
    const since = (
      await withTransaction(h.adminPool, (tx) => tx.one<{ now: Date }>('select now() as now'))
    ).now;
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
    const urgent = () =>
      withTransaction(notifier, (tx) =>
        tx.query<{ person_id: string; kind: string }>(
          'select person_id, kind from core.urgent_notifications($1)',
          [since],
        ),
      );
    expect(await urgent()).toEqual([{ person_id: f.performerId, kind: 'proposal_waiting' }]);
    // The proposal appears in the digest as an item, with its act's name and the target's title.
    const proposal = (await digestFor(f.performerId)).find((row) => row.kind === 'proposal');
    expect(proposal?.title).toBe('accept_decision: Adopt the second-source capacitor');

    await setPreference('performer', { digest: 'daily', push: 'off' });
    try {
      expect(await urgent()).toEqual([]);
    } finally {
      await setPreference('performer', { digest: 'daily', push: 'urgent' });
    }
  });
});

describe('each guard, falsified', () => {
  async function without(ddl: string, body: () => Promise<void>): Promise<void> {
    await withTransaction(h.adminPool, (tx) => tx.query(ddl.split('||')[0]!));
    try {
      await body();
    } finally {
      await withTransaction(h.adminPool, (tx) => tx.query(ddl.split('||')[1]!));
    }
  }

  it('without the ceiling check, a restricted title leaves in the digest', async () => {
    await without(
      `create or replace function core.may_leave_host(p_organization uuid, p_classification text)
         returns boolean language sql stable as $$ select true $$||` +
        `create or replace function core.may_leave_host(p_organization uuid, p_classification text)
         returns boolean language sql stable security definer
         set search_path = pg_catalog, core, registry as $$
           select coalesce(
             (select c.rank <= ceiling.rank
                from registry.classification c, registry.classification ceiling
               where c.id = p_classification
                 and ceiling.id = core.provider_ceiling_in_force(p_organization)),
             false) $$`,
      async () => {
        expect(JSON.stringify(await digestFor(f.reviewerId))).toContain('Halberd');
      },
    );
    expect(JSON.stringify(await digestFor(f.reviewerId))).not.toContain('Halberd');
  });

  it('without the read check, a record the person cannot read is listed', async () => {
    // The reviewer's clearance lowered to confidential: the restricted record is no longer theirs to
    // read, so the digest drops it, as Needs you does. Then the check is removed, and it is back.
    const clearance = (to: string) =>
      withTransaction(h.adminPool, (tx) =>
        tx.query(
          `update org.person_clearance set max_classification = $3
            where subject_id = $1 and organization_id = $2`,
          [f.reviewerId, f.organizationId, to],
        ),
      );
    const listsRestricted = async () =>
      (
        await withTransaction(h.adminPool, (tx) =>
          tx.query<{ n: string }>(
            `select count(*)::text as n from core.needs_you_digest()
            where person_id = $1 and kind = 'to_verify' and not disclosed`,
            [f.reviewerId],
          ),
        )
      )[0]!.n !== '0';
    await clearance('confidential');
    try {
      expect(await listsRestricted()).toBe(false);
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
          expect(await listsRestricted()).toBe(true);
        },
      );
      expect(await listsRestricted()).toBe(false);
    } finally {
      await clearance('restricted');
    }
  });

  it('without the routing bound and its check, an owner widens the ceiling to restricted', async () => {
    await without(
      'drop trigger model_routing_policy_bounded on core.model_routing_policy; ' +
        'alter table core.model_routing_policy drop constraint model_routing_policy_provider_ceiling_check||' +
        'alter table core.model_routing_policy add constraint model_routing_policy_provider_ceiling_check ' +
        `check (provider_ceiling in ('none', 'public', 'internal')); ` +
        'create trigger model_routing_policy_bounded before insert or update or delete on ' +
        'core.model_routing_policy for each row execute function core.model_routing_policy_bounded()',
      async () => {
        await withTransaction(h.adminPool, async (tx) => {
          await bindContext(tx, f, f.reviewerId);
          await tx.query(
            `insert into core.model_routing_policy
               (organization_id, provider_ceiling, reason, set_by, set_by_action)
             select $1, 'restricted', 'an owner widening the ceiling', $2, a.id
               from core.action a where a.action_type = 'record_observation'
              order by a.recorded_at limit 1`,
            [f.organizationId, f.reviewerId],
          );
        });
        const widened = await withTransaction(h.adminPool, (tx) =>
          tx.one<{ ceiling: string }>('select core.provider_ceiling_in_force($1) as ceiling', [
            f.organizationId,
          ]),
        );
        expect(widened.ceiling).toBe('restricted');
        // Taken back out while the bound is down, so the restored check can be added again.
        await withTransaction(h.adminPool, async (tx) => {
          await bindContext(tx, f, f.reviewerId);
          await tx.query(
            `delete from core.model_routing_policy where provider_ceiling = 'restricted'`,
          );
        });
      },
    );
  });

  it('without the notification bound, an agent turns its person’s digest off', async () => {
    await without(
      'drop trigger notification_preference_bounded on core.notification_preference||' +
        'create trigger notification_preference_bounded before insert or update or delete on ' +
        'core.notification_preference for each row execute function ' +
        'core.notification_preference_bounded()',
      async () => {
        const set = await setPreference('performer', { digest: 'off' }, AGENT);
        expect(set.receipt).toMatchObject({ digest: 'off' });
      },
    );
    await setPreference('performer', { digest: 'daily', push: 'urgent' });
  });
});
