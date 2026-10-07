/**
 * Agents submit; authority verifies — in the database (ADR 0040 decisions 5 and 6,
 * KF-SAS-RQ-263 to RQ-265; 20261007100000).
 *
 * Every act here goes through the real fabric dispatcher on the application login, bound on an
 * attestation issued through the attestor's login exactly as kf-attestor issues one: the
 * performer's own token, or a token exchanged for the declared agent. What must hold:
 *
 *   - what an agent writes carries its participation and is unverified, until a person with
 *     authority verifies it or a policy in force for its kind, act and agent does — and a record
 *     verified by policy names the policy;
 *   - no agent performs an institutional act, records a verification, sets a policy or resolves a
 *     proposal, whatever grants reach its person;
 *   - no policy can name an institutional act, and no `verified_by_policy` row can be forged;
 *   - an agent's proposal performs nothing, and is confirmed only by its person performing
 *     exactly that act.
 *
 * Each guard is FALSIFIED in the last block: dropped inside a transaction, the forbidden thing
 * happens, so the assertion that it does not is an assertion about the guard.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionRejected, type ActionRequest } from '@kf/actions';
import { InMemoryObjectStore } from '@kf/artifacts';
import { proposalRequest } from '@kf/authorization';
import { issueAttestation, withTransaction, type Principal } from '@kf/database';
import { PandocDocumentParser, createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { formObservationRequest } from '@kf/work-control';
import { runDeclareAgent } from '../../apps/api/src/admin/declare-agent.js';
import { bindContext, seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

const AGENT = 'colleague-agent';
const OTHER_AGENT = 'other-colleague-agent';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createFabricDispatcher>;

const principal = (who: 'performer' | 'reviewer'): Principal => ({
  actorId: who === 'performer' ? f.performerId : f.reviewerId,
  actingRoleId: who === 'performer' ? f.performerRoleId : f.reviewerRoleId,
  organizationId: f.organizationId,
  maxClassification: 'restricted',
});

/** What kf-attestor stores after verifying a person's own token, or one exchanged for `agent`. */
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

let gesture = 0;
/** `null` is the person's own token; a default parameter would turn `undefined` into AGENT. */
async function capture(agent: string | null = AGENT): Promise<string> {
  gesture += 1;
  const request = formObservationRequest({
    organizationId: f.organizationId,
    actorId: f.performerId,
    liveAssignmentIds: [f.performerRoleId],
    gestureId: `colleague-${randomUUID()}`,
    body: `Bench reading ${String(gesture)}: rail at 3.31 V under load`,
    maxClassification: 'restricted',
  });
  const result = await execute({
    ...request,
    attestation: await attest('performer', agent ?? undefined),
  });
  expect(result.objectIds).toHaveLength(1);
  return result.objectIds[0]!;
}

async function setPolicy(
  mode: 'required' | 'verified_on_submit',
  over: { objectType?: string; actionType?: string; agent?: string; by?: string } = {},
) {
  return as('reviewer', over.by, {
    actionType: 'set_verification_policy',
    targetIds: [f.organizationId],
    payload: {
      object_type: over.objectType ?? 'observation',
      action_type: over.actionType ?? 'record_observation',
      agent_client_id: over.agent ?? AGENT,
      mode,
    },
    reason: `the organization ${mode === 'required' ? 'withdraws its trust in' : 'trusts'} this agent's bench notes`,
    idempotencyKey: `policy-${randomUUID()}`,
  });
}

const verificationOf = (objectId: string) =>
  withTransaction(h.adminPool, (tx) =>
    tx.maybeOne<{
      basis: string;
      verified_by: string;
      policy_id: string | null;
      recorded_by_action: string;
    }>(
      `select basis, verified_by, policy_id, recorded_by_action
         from core.object_verification where object_id = $1`,
      [objectId],
    ),
  );

const participationOf = (actionId: string) =>
  withTransaction(h.adminPool, (tx) =>
    tx.one<{ agent_participation: string | null }>(
      'select agent_participation from core.action where id = $1',
      [actionId],
    ),
  );

/** The refusal an act met, as every surface receives it. */
async function refusal(promise: Promise<unknown>): Promise<ActionRejected> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ActionRejected) return error;
    throw error;
  }
  throw new Error('expected a refusal; the act was applied');
}

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
  for (const clientId of [AGENT, OTHER_AGENT]) {
    await runDeclareAgent(h.adminPool, {
      clientId,
      declaredBy: f.reviewerId,
      reason: 'a colleague agent under test',
      withdraw: false,
    });
  }
}, 240_000);

afterAll(async () => {
  await h?.stop();
});

/** Wait out the individual-review pace (20260924000300) between two reviews by one verifier. */
const pastThePace = () => new Promise((resolve) => setTimeout(resolve, 1_100));

describe('what an agent writes is submitted, not trusted', () => {
  it('records the agent and no verification', async () => {
    const id = await capture();
    expect(await verificationOf(id)).toBeUndefined();
    const act = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ agent_participation: string | null }>(
        `select agent_participation from core.action where $1 = any(target_ids)
          and action_type = 'record_observation'`,
        [id],
      ),
    );
    expect(act.agent_participation).toBe(AGENT);
  });

  it('becomes verified when a person with authority verifies it', async () => {
    const id = await capture();
    await pastThePace();
    const verified = await as('reviewer', undefined, {
      actionType: 'verify_record',
      targetIds: [id],
      payload: { basis: 'reviewed_individually' },
      reason: 'read the bench note against the log',
      idempotencyKey: `verify-${randomUUID()}`,
    });
    expect(await verificationOf(id)).toMatchObject({
      basis: 'reviewed_individually',
      verified_by: f.reviewerId,
      policy_id: null,
      recorded_by_action: verified.actionId,
    });
  });

  it('an agent cannot verify, even its own person’s colleague’s records', async () => {
    const id = await capture(OTHER_AGENT);
    const refused = await refusal(
      as('reviewer', AGENT, {
        actionType: 'verify_record',
        targetIds: [id],
        payload: { basis: 'promoted_in_bulk' },
        reason: 'an agent claiming to have checked it',
        idempotencyKey: `verify-${randomUUID()}`,
      }),
    );
    expect(refused.detail['rule']).toBe('KF-AGENT-002');
    expect(await verificationOf(id)).toBeUndefined();
  });
});

describe('a verification policy, set by an attributed act', () => {
  it('verifies on arrival, naming the policy and who set it', async () => {
    const set = await setPolicy('verified_on_submit');
    const policyId = String(set.receipt?.['policyId']);
    expect(set.receipt).toMatchObject({ mode: 'verified_on_submit', agentClientId: AGENT });

    const id = await capture();
    const verification = await verificationOf(id);
    expect(verification).toMatchObject({
      basis: 'verified_by_policy',
      policy_id: policyId,
      verified_by: f.reviewerId,
    });
    expect((await participationOf(verification!.recorded_by_action)).agent_participation).toBe(
      AGENT,
    );
  });

  it('applies only to the agent it names', async () => {
    const id = await capture(OTHER_AGENT);
    expect(await verificationOf(id)).toBeUndefined();
  });

  it('never to a person acting directly', async () => {
    const id = await capture(null);
    expect(await verificationOf(id)).toBeUndefined();
  });

  it('is superseded by a later act: back to required, back to unverified', async () => {
    await setPolicy('required');
    const id = await capture();
    expect(await verificationOf(id)).toBeUndefined();
    await setPolicy('verified_on_submit');
  });

  it('is refused for an institutional act (KF-VPOL-001)', async () => {
    const refused = await refusal(
      setPolicy('verified_on_submit', { actionType: 'promote_observation' }),
    );
    expect(refused.detail['rule']).toBe('KF-VPOL-001');
  });

  it('is refused for an institutional act even over the owner credential', async () => {
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await bindContext(tx, f, f.reviewerId);
        await tx.query(
          `insert into core.verification_policy
             (organization_id, object_type, action_type, agent_client_id, mode, reason, set_by,
              set_by_action)
           values ($1, 'observation', 'promote_observation', $2, 'verified_on_submit',
                   'an owner trying it directly', $3, core.current_action_id())`,
          [f.organizationId, AGENT, f.reviewerId],
        );
      }),
    ).rejects.toThrow(/KF-VPOL-001/);
  });

  it('is refused for an agent nobody declared (KF-VPOL-002)', async () => {
    const refused = await refusal(setPolicy('verified_on_submit', { agent: 'never-declared' }));
    expect(refused.detail['rule']).toBe('KF-VPOL-002');
  });

  it('cannot be set by an agent: setting it is institutional (KF-AGENT-001)', async () => {
    const refused = await refusal(setPolicy('verified_on_submit', { by: AGENT }));
    expect(refused.detail['rule']).toBe('KF-AGENT-001');
  });

  it('a verified_by_policy row cannot be forged (KF-VPOL-003)', async () => {
    // A record the agent did NOT write, with the live policy's id and setter: the database
    // refuses, because no act in force wrote it under that policy.
    const id = await capture(null);
    const policy = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ id: string }>(
        `select id from core.verification_policy order by revision desc limit 1`,
      ),
    );
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindContext(tx, f, f.reviewerId);
        await tx.query(
          `insert into core.object_verification
             (object_id, verified_by, basis, policy_id, recorded_by_action)
           values ($1, $2, 'verified_by_policy', $3, core.current_action_id())`,
          [id, f.reviewerId, policy.id],
        );
      }),
    ).rejects.toThrow(/KF-VPOL-003/);
  });
});

describe('an institutional act is proposed by the agent and performed by its person', () => {
  let observation: string;

  beforeAll(async () => {
    await setPolicy('required');
    observation = await capture();
  });

  it('an agent performing one is refused, though its person holds act authority (KF-AGENT-001)', async () => {
    const refused = await refusal(
      as('performer', AGENT, {
        actionType: 'promote_observation',
        targetIds: [observation],
        reason: 'promoting the bench reading to the record',
        idempotencyKey: `promote-${randomUUID()}`,
      }),
    );
    expect(refused.detail['rule']).toBe('KF-AGENT-001');
    const state = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ lifecycle_state: string }>('select lifecycle_state from core.object where id = $1', [
        observation,
      ]),
    );
    expect(state.lifecycle_state).toBe('captured');
  });

  it('a proposal performs nothing; a wrong act does not confirm it; its person’s act does', async () => {
    const proposed = await as('performer', AGENT, {
      actionType: 'propose_act',
      targetIds: [observation],
      payload: {
        action_type: 'promote_observation',
        target_ids: [observation],
        payload: {},
        reason: 'the reading is confirmed by the log; promote it',
      },
      reason: 'agent proposes promotion for its person',
      idempotencyKey: `propose-${randomUUID()}`,
    });
    const proposalId = String(proposed.receipt?.['proposalId']);
    expect(proposed.receipt).toMatchObject({
      actionType: 'promote_observation',
      agentClientId: AGENT,
    });
    const row = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ proposed_for: string; agent_client_id: string; request_digest: string }>(
        'select proposed_for, agent_client_id, request_digest from core.act_proposal where id = $1',
        [proposalId],
      ),
    );
    expect(row).toMatchObject({ proposed_for: f.performerId, agent_client_id: AGENT });

    // The agent cannot answer its own proposal.
    const byAgent = await refusal(
      as('performer', AGENT, {
        actionType: 'resolve_act_proposal',
        targetIds: [observation],
        payload: { proposal_id: proposalId, resolution: 'declined' },
        reason: 'an agent declining for its person',
        idempotencyKey: `resolve-${randomUUID()}`,
      }),
    );
    expect(byAgent.detail['rule']).toBe('KF-AGENT-002');

    // An unrelated act of the person does not confirm it.
    const unrelated = await as('performer', undefined, {
      actionType: 'create_initiative',
      targetIds: [],
      payload: { title: 'Unrelated', objective: 'Not the proposal.', sponsor_id: f.performerId },
      idempotencyKey: `unrelated-${randomUUID()}`,
    });
    const wrong = await refusal(
      as('performer', undefined, {
        actionType: 'resolve_act_proposal',
        targetIds: [observation],
        payload: {
          proposal_id: proposalId,
          resolution: 'confirmed',
          performed_action: unrelated.actionId,
        },
        idempotencyKey: `resolve-${randomUUID()}`,
      }),
    );
    expect(wrong.detail['rule']).toBe('KF-AGENT-005');

    // The person performs exactly what was proposed, on their own token: every check runs now.
    const performed = await execute({
      ...proposalRequest(
        {
          actionType: 'promote_observation',
          targetIds: [observation],
          payload: {},
          reason: 'the reading is confirmed by the log; promote it',
        },
        principal('performer'),
        `proposal-${proposalId}`,
      ),
      attestation: await attest('performer'),
    });
    expect((await participationOf(performed.actionId)).agent_participation).toBeNull();
    const confirmed = await as('performer', undefined, {
      actionType: 'resolve_act_proposal',
      targetIds: [observation],
      payload: {
        proposal_id: proposalId,
        resolution: 'confirmed',
        performed_action: performed.actionId,
      },
      idempotencyKey: `resolve-${randomUUID()}`,
    });
    expect(confirmed.receipt).toMatchObject({ resolution: 'confirmed' });
    // Promoted by its person; still unverified: no policy reaches an institutional act.
    expect(await verificationOf(observation)).toBeUndefined();

    // Once.
    const again = await refusal(
      as('performer', undefined, {
        actionType: 'resolve_act_proposal',
        targetIds: [observation],
        payload: { proposal_id: proposalId, resolution: 'declined' },
        reason: 'changing my mind after confirming',
        idempotencyKey: `resolve-${randomUUID()}`,
      }),
    );
    expect(again.message).toMatch(/already confirmed/);
  });

  it('a person cannot propose; a proposal is an agent’s (KF-AGENT-004)', async () => {
    await expect(
      as('performer', undefined, {
        actionType: 'propose_act',
        targetIds: [observation],
        payload: { action_type: 'promote_observation', target_ids: [observation], payload: {} },
        idempotencyKey: `propose-${randomUUID()}`,
      }),
    ).rejects.toThrow(/KF-AGENT-004/);
  });

  it('a non-institutional act is performed, not proposed (KF-AGENT-003)', async () => {
    const refused = await refusal(
      as('performer', AGENT, {
        actionType: 'propose_act',
        targetIds: [observation],
        payload: { action_type: 'withdraw_observation', target_ids: [observation], payload: {} },
        idempotencyKey: `propose-${randomUUID()}`,
      }),
    );
    expect(refused.detail['rule']).toBe('KF-AGENT-003');
  });

  it('another person sees nobody else’s proposals', async () => {
    const seen = await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.bind_principal($1, $2, $3, $4, $5)', [
        f.reviewerId,
        f.reviewerRoleId,
        f.organizationId,
        'restricted',
        await attest('reviewer'),
      ]);
      return tx.one<{ n: string }>('select count(*)::text as n from core.act_proposal');
    });
    expect(seen.n).toBe('0');
  });
});

describe('each guard, falsified', () => {
  /** Run `body` with `ddl` applied, inside a transaction that is always rolled back. */
  async function without(ddl: string, body: () => Promise<void>): Promise<void> {
    // DDL is transactional in PostgreSQL, but the dispatcher opens its own transactions; so the
    // guard is dropped for real and put back from the migration's own definition afterwards.
    await withTransaction(h.adminPool, (tx) => tx.query(ddl.split('||')[0]!));
    try {
      await body();
    } finally {
      await withTransaction(h.adminPool, (tx) => tx.query(ddl.split('||')[1]!));
    }
  }

  it('without the agent bar, an agent performs an institutional act', async () => {
    const observation = await capture();
    await without(
      'drop trigger action_agent_bar on core.action||' +
        'create trigger action_agent_bar before insert on core.action ' +
        'for each row execute function core.action_agent_bar()',
      async () => {
        const result = await as('performer', AGENT, {
          actionType: 'promote_observation',
          targetIds: [observation],
          reason: 'promoting with the bar removed',
          idempotencyKey: `promote-${randomUUID()}`,
        });
        expect((await participationOf(result.actionId)).agent_participation).toBe(AGENT);
      },
    );
  });

  it('without the commit-time trigger, a trusted agent’s record stays unverified', async () => {
    await setPolicy('verified_on_submit');
    await without(
      'drop trigger object_verified_by_policy on core.object||' +
        'create constraint trigger object_verified_by_policy after insert on core.object ' +
        'deferrable initially deferred for each row ' +
        'when (core.current_agent_or_null() is not null) ' +
        'execute function core.verify_by_policy_at_commit()',
      async () => {
        expect(await verificationOf(await capture())).toBeUndefined();
      },
    );
    // And with it back, verified again: the assertion above was about the trigger.
    expect((await verificationOf(await capture()))?.basis).toBe('verified_by_policy');
    await setPolicy('required');
  });

  it('without the policy bound, an institutional act can be named verified on submit', async () => {
    await without(
      'drop trigger verification_policy_bounded on core.verification_policy||' +
        'create trigger verification_policy_bounded before insert or update or delete on ' +
        'core.verification_policy for each row execute function core.verification_policy_bounded()',
      async () => {
        const set = await setPolicy('verified_on_submit', {
          actionType: 'promote_observation',
        });
        expect(set.receipt).toMatchObject({ actionType: 'promote_observation' });
      },
    );
  });

  it('without the basis guard, an agent records a verification', async () => {
    const id = await capture(OTHER_AGENT);
    await without(
      'drop trigger action_agent_bar on core.action; ' +
        'drop trigger object_verification_basis_guard on core.object_verification||' +
        'create trigger action_agent_bar before insert on core.action ' +
        'for each row execute function core.action_agent_bar(); ' +
        'create trigger object_verification_basis_guard before insert on core.object_verification ' +
        'for each row execute function core.object_verification_basis_guard()',
      async () => {
        await as('reviewer', AGENT, {
          actionType: 'verify_record',
          targetIds: [id],
          payload: { basis: 'promoted_in_bulk' },
          reason: 'an agent claiming to have checked it',
          idempotencyKey: `verify-${randomUUID()}`,
        });
        expect((await verificationOf(id))?.basis).toBe('promoted_in_bulk');
      },
    );
  });
});
