import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  issueAttestation,
  withTransaction,
  type Pool,
  type Principal,
  type Tx,
} from '@kf/database';
import {
  planDeclareAgent,
  runDeclareAgent,
  type DeclareAgentDecision,
} from '../../apps/api/src/admin/declare-agent.js';
import { seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

/**
 * An agent acts for a named human, and the database — not the caller — records that it did
 * (ADR 0035, 20260925100000).
 *
 * The chain under test: `core.issue_attestation` refuses an agent that is not declared and stores
 * the one that is; `core.bind_principal` seals the attestation's agent; a trigger copies it onto
 * `core.action.agent_participation`, overwriting whatever the application wrote. Every bind here
 * runs through a bare `kf_app` login with NO attestation issuer registered — the production API's
 * position — so the only way an agent reaches the ledger is through the attestation.
 */
describe('agent participation is the database’s record', () => {
  let h: Harness;
  let f: Fixtures;
  let app: Pool;
  const AGENT = 'knowledge-fabric-agent';
  const WITHDRAWN = 'retired-agent';

  const declaration = (over: Partial<DeclareAgentDecision> = {}): DeclareAgentDecision => {
    const plan = planDeclareAgent({
      clientId: AGENT,
      declaredBy: f.reviewerId,
      reason: 'drafting assistant under test',
      ...over,
    });
    if (!plan.ok) throw new Error(plan.refusals.join('; '));
    return plan.decision;
  };

  beforeAll(async () => {
    h = await startHarness();
    f = await seedFixtures(h.adminPool);
    await withTransaction(h.adminPool, async (tx) => {
      await tx.query(`create role kf_agent_test_app login password 'test-only-not-a-secret'`);
      await tx.query('grant kf_app to kf_agent_test_app');
      await tx.query('grant connect on database kf_test to kf_agent_test_app');
    });
    const uri = new URL(h.connectionString);
    uri.username = 'kf_agent_test_app';
    uri.password = 'test-only-not-a-secret';
    app = createPool({ connectionString: uri.toString(), maxConnections: 2 });

    await runDeclareAgent(h.adminPool, declaration());
    await runDeclareAgent(h.adminPool, declaration({ clientId: WITHDRAWN }));
    await runDeclareAgent(h.adminPool, declaration({ clientId: WITHDRAWN, withdraw: true }));
  }, 240_000);

  afterAll(async () => {
    await app?.end();
    await h?.stop();
  });

  const performer = (): Principal => ({
    actorId: f.performerId,
    actingRoleId: f.performerRoleId,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
  });

  /** What kf-attestor does after verifying a token with this `act.client_id` and `azp`. */
  const attest = (agentClientId?: string, authorizedParty?: string): Promise<string> =>
    withTransaction(h.attestorPool, (tx) =>
      issueAttestation(tx, performer(), undefined, { agentClientId, authorizedParty }),
    );

  const attestations = async (): Promise<number> =>
    Number(
      (
        await withTransaction(h.adminPool, (tx) =>
          tx.one<{ n: string }>('select count(*)::text as n from core.principal_attestation'),
        )
      ).n,
    );

  /** The dispatcher's order: bind the principal, bind the act, write the ledger row. */
  async function act(tx: Tx, attestation: string, supplied: string | null = null): Promise<string> {
    const actionId = randomUUID();
    await tx.query('select core.bind_principal($1, $2, $3, $4, $5)', [
      f.performerId,
      f.performerRoleId,
      f.organizationId,
      'restricted',
      attestation,
    ]);
    await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
      f.performerId,
      f.performerRoleId,
      actionId,
      'agent-participation-test',
    ]);
    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, idempotency_key, effective_at, result_status, agent_participation)
       values ($1, $2, repeat('a', 64), 'create_initiative', $3, $4, array[$2]::uuid[], $5,
               date_trunc('milliseconds', now()), 'applied', $6)`,
      [
        actionId,
        f.organizationId,
        f.performerId,
        f.performerRoleId,
        `agent-${actionId.slice(0, 12)}`,
        supplied,
      ],
    );
    return actionId;
  }

  const participationOf = async (actionId: string): Promise<string | null> =>
    (
      await withTransaction(h.adminPool, (tx) =>
        tx.one<{ agent_participation: string | null }>(
          'select agent_participation from core.action where id = $1',
          [actionId],
        ),
      )
    ).agent_participation;

  describe('the ledger', () => {
    it('records the agent of the attestation the act was bound on', async () => {
      const attestation = await attest(AGENT, AGENT);
      const id = await withTransaction(app, (tx) => act(tx, attestation));
      expect(await participationOf(id)).toBe(AGENT);
    });

    it('records null for a person acting on their own token', async () => {
      const attestation = await attest(undefined, 'knowledge-fabric-web');
      const id = await withTransaction(app, (tx) => act(tx, attestation));
      expect(await participationOf(id)).toBeNull();
    });

    it('overwrites a participation the application supplied, in both directions', async () => {
      const own = await attest(undefined, 'knowledge-fabric-web');
      const claimed = await withTransaction(app, (tx) => act(tx, own, AGENT));
      expect(await participationOf(claimed)).toBeNull();

      const agents = await attest(AGENT, AGENT);
      const hidden = await withTransaction(app, (tx) => act(tx, agents, 'some-other-agent'));
      expect(await participationOf(hidden)).toBe(AGENT);
    });

    it('a second bind on the person’s own token clears the agent a first bind sealed', async () => {
      const agents = await attest(AGENT, AGENT);
      const own = await attest(undefined, 'knowledge-fabric-web');
      const id = await withTransaction(app, async (tx) => {
        await tx.query('select core.bind_principal($1, $2, $3, $4, $5)', [
          f.performerId,
          f.performerRoleId,
          f.organizationId,
          'restricted',
          agents,
        ]);
        return act(tx, own);
      });
      expect(await participationOf(id)).toBeNull();
    });

    it('left every row written before it null', async () => {
      // Fixture acts are the migration-era history here: none acted through an agent.
      const { history, attributed } = await withTransaction(h.adminPool, (tx) =>
        tx.one<{ history: string; attributed: string }>(
          `select count(*)::text as history,
                  count(*) filter (where agent_participation is not null)::text as attributed
             from core.action
            where idempotency_key not like 'agent-%' and idempotency_key not like 'restore-%'`,
        ),
      );
      expect(Number(history)).toBeGreaterThan(0);
      expect(attributed).toBe('0');
    });

    it('keeps a value an administrator session supplies, as a restore must', async () => {
      const id = randomUUID();
      await withTransaction(h.adminPool, async (tx) => {
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          f.performerId,
          f.performerRoleId,
          id,
          'agent-participation-restore',
        ]);
        await tx.query(
          `insert into core.action
             (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
              target_ids, idempotency_key, effective_at, result_status, agent_participation)
           values ($1, $2, repeat('b', 64), 'create_initiative', $3, $4, array[$2]::uuid[], $5,
                   date_trunc('milliseconds', now()), 'applied', $6)`,
          [
            id,
            f.organizationId,
            f.performerId,
            f.performerRoleId,
            `restore-${id.slice(0, 12)}`,
            AGENT,
          ],
        );
      });
      expect(await participationOf(id)).toBe(AGENT);
    });
  });

  describe('the attestation', () => {
    it.each([
      ['a client nobody declared', 'unknown-agent', 'unknown-agent', /not a declared agent/],
      ['a withdrawn agent', WITHDRAWN, WITHDRAWN, /not a declared agent/],
      [
        'an agent that is not the client the token was issued to',
        AGENT,
        'knowledge-fabric-web',
        /but was issued to client/,
      ],
      [
        "a declared agent's token that does not name it",
        undefined,
        AGENT,
        /its token does not name it/,
      ],
      [
        "a withdrawn agent's token that does not name it",
        undefined,
        WITHDRAWN,
        /its token does not name it/,
      ],
    ] as const)('refuses %s, and stores nothing', async (_name, agent, azp, message) => {
      const before = await attestations();
      await expect(attest(agent, azp)).rejects.toThrow(message);
      expect(await attestations()).toBe(before);
    });

    it('is not the application’s to issue, with or without an agent', async () => {
      await expect(
        withTransaction(app, (tx) =>
          issueAttestation(tx, performer(), undefined, {
            agentClientId: AGENT,
            authorizedParty: AGENT,
          }),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('the declaration', () => {
    it('is not readable or writable by the application login', async () => {
      await expect(
        withTransaction(app, (tx) => tx.query('select client_id from org.declared_agent')),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTransaction(app, (tx) =>
          tx.query(
            `insert into org.declared_agent (client_id, declared_by, reason)
             values ('self-declared', $1, 'the api declares itself')`,
            [f.performerId],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('is withdrawn, never deleted or rewritten, and withdrawn once', async () => {
      await expect(
        withTransaction(h.adminPool, (tx) =>
          tx.query('delete from org.declared_agent where client_id = $1', [AGENT]),
        ),
      ).rejects.toThrow(/withdrawn, never deleted/);
      await expect(
        withTransaction(h.adminPool, (tx) =>
          tx.query(
            `update org.declared_agent set reason = 'rewritten after the fact' where client_id = $1`,
            [AGENT],
          ),
        ),
      ).rejects.toThrow(/withdrawn, not rewritten/);
      await expect(
        runDeclareAgent(h.adminPool, declaration({ clientId: WITHDRAWN, withdraw: true })),
      ).rejects.toThrow(/already withdrawn/);
      await expect(
        runDeclareAgent(h.adminPool, declaration({ clientId: WITHDRAWN })),
      ).rejects.toThrow(/not re-declared/);
    });

    it('is refused without a human decider holding a live role', async () => {
      await expect(
        runDeclareAgent(
          h.adminPool,
          declaration({ clientId: 'nobody-decided', declaredBy: randomUUID() }),
        ),
      ).rejects.toThrow(/is not a person/);
    });

    it('declaring a live agent again writes nothing', async () => {
      const again = await runDeclareAgent(h.adminPool, declaration());
      expect(again.unchanged).toBe(true);
    });
  });
});
