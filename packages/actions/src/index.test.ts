import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@kf/database';
import { auditChainDigest, GENESIS_DIGEST } from '@kf/canonicalization';
import {
  createTransactionalDispatcher,
  createTransactionalPreflight,
  semanticActionRequestDigest,
  type ActionRequest,
  type ObjectRow,
} from './index.js';

const REQUEST: ActionRequest = {
  actionType: 'create_test_record',
  actorId: '11111111-1111-7111-8111-111111111111',
  actingRoleId: '22222222-2222-7222-8222-222222222222',
  targetIds: [],
  idempotencyKey: 'test-preflight-0001',
  organizationId: '33333333-3333-7333-8333-333333333333',
  maxClassification: 'internal',
};

const PROSPECTIVE_OBJECT: ObjectRow = {
  id: '44444444-4444-7444-8444-444444444444',
  object_type: 'test_record',
  lifecycle_state: 'draft',
  row_version: '0',
  organization_id: REQUEST.organizationId,
  created_by: REQUEST.actorId,
};

function preflightTx(roleHeld: boolean) {
  const statements: string[] = [];
  const tx = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes('registry.state_transition')) return [];
      return [];
    },
    async one() {
      throw new Error('unexpected one()');
    },
    async maybeOne(sql: string) {
      statements.push(sql);
      if (sql.includes('registry.action_type'))
        return { id: REQUEST.actionType, transactional: true };
      if (sql.includes('org.resolve_effective_classification'))
        return { requested_classification: REQUEST.maxClassification };
      if (sql.includes('org.holds_role')) return { ok: roleHeld };
      return undefined;
    },
  } as unknown as Tx;
  return { statements, tx };
}

const PURE_TRANSITION_REQUEST: ActionRequest = {
  ...REQUEST,
  actionType: 'triage_initiative',
  targetIds: ['55555555-5555-7555-8555-555555555555'],
  idempotencyKey: 'test-pure-transition-0001',
};

function replayReceipt(request: ActionRequest = PURE_TRANSITION_REQUEST) {
  const id = '77777777-7777-7777-8777-777777777777';
  const effectiveAt = '2026-08-14T12:00:00.000Z';
  const beforeDigest = null;
  const afterDigest = 'b'.repeat(64);
  const auditDigest = auditChainDigest(GENESIS_DIGEST, {
    action_id: id,
    action_type: request.actionType,
    actor_id: request.actorId,
    acting_role_id: request.actingRoleId,
    object_ids: [...request.targetIds].sort(),
    effective_at: effectiveAt,
    before_digest: beforeDigest,
    after_digest: afterDigest,
  });
  return {
    id,
    actor_id: request.actorId,
    acting_role_id: request.actingRoleId,
    organization_id: request.organizationId,
    target_ids: [...request.targetIds],
    request_digest: semanticActionRequestDigest(request),
    result_status: 'applied',
    action_type: request.actionType,
    action_effective_at_exact: '2026-08-14T12:00:00.000000Z',
    action_request_id: null,
    action_reason: null,
    event_count: 1,
    event_actor_id: request.actorId,
    event_acting_role_id: request.actingRoleId,
    event_action_type: request.actionType,
    event_object_id: request.targetIds.length === 1 ? request.targetIds[0]! : null,
    event_effective_at_exact: '2026-08-14T12:00:00.000000Z',
    event_effective_at_wire: effectiveAt,
    event_request_id: null,
    event_reason: null,
    event_before_digest: beforeDigest,
    event_after_digest: afterDigest,
    event_prev_digest: GENESIS_DIGEST,
    audit_digest: auditDigest,
  };
}

function dispatcherTx() {
  const statements: string[] = [];
  const accessContexts: unknown[][] = [];
  const object: ObjectRow = {
    id: PURE_TRANSITION_REQUEST.targetIds[0]!,
    object_type: 'initiative_project',
    lifecycle_state: 'captured',
    row_version: '0',
    organization_id: PURE_TRANSITION_REQUEST.organizationId,
    created_by: '66666666-6666-7666-8666-666666666666',
  };
  const tx = {
    async query(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes('core.set_access_context')) accessContexts.push([...(params ?? [])]);
      if (sql.includes('registry.state_transition')) {
        return [
          {
            machine: object.object_type,
            from_state: object.lifecycle_state,
            to_state: 'triage',
          },
        ];
      }
      if (sql.includes('from core.object') && sql.includes('for update')) return [object];
      return [];
    },
    async one(sql: string) {
      statements.push(sql);
      if (sql.includes('core.audit_chain_head')) return { digest: GENESIS_DIGEST };
      if (sql.includes('uuidv7()')) return { id: '77777777-7777-7777-8777-777777777777' };
      throw new Error(`unexpected one(): ${sql}`);
    },
    async maybeOne(sql: string) {
      statements.push(sql);
      if (sql.includes('from core.action')) return undefined;
      if (sql.includes('registry.action_type')) {
        return { id: PURE_TRANSITION_REQUEST.actionType, transactional: true };
      }
      if (sql.includes('org.resolve_effective_classification')) {
        return { requested_classification: PURE_TRANSITION_REQUEST.maxClassification };
      }
      if (sql.includes('org.holds_role')) return { ok: true };
      if (sql.includes('from core.audit_event')) return undefined;
      throw new Error(`unexpected maybeOne(): ${sql}`);
    },
  } as unknown as Tx;
  return { statements, accessContexts, tx };
}

describe('transactional action preflight', () => {
  it('runs existing authority and precondition contracts without authoritative writes', async () => {
    const boundary = preflightTx(true);
    const precondition = vi.fn(async () => undefined);
    const preflight = createTransactionalPreflight({
      materializers: { create_test_record: vi.fn() },
      preconditions: { create_test_record: precondition },
    });

    await preflight(boundary.tx, REQUEST, [PROSPECTIVE_OBJECT]);

    expect(precondition).toHaveBeenCalledWith(boundary.tx, REQUEST, [PROSPECTIVE_OBJECT]);
    expect(
      boundary.statements.some((sql) =>
        /(?:insert\s+into|update|delete\s+from)\s+core\.(?:action|audit_event|outbox)/i.test(sql),
      ),
    ).toBe(false);
  });

  it('refuses an unheld role before action-specific preconditions', async () => {
    const boundary = preflightTx(false);
    const precondition = vi.fn(async () => undefined);
    const preflight = createTransactionalPreflight({
      materializers: { create_test_record: vi.fn() },
      preconditions: { create_test_record: precondition },
    });

    await expect(preflight(boundary.tx, REQUEST, [PROSPECTIVE_OBJECT])).rejects.toEqual(
      expect.objectContaining({ failure: 'role_not_held' }),
    );
    expect(precondition).not.toHaveBeenCalled();
  });
});

describe('transactional action ownership', () => {
  it.each([
    new Date(Number.NaN),
    new Date('0000-01-01T00:00:00.000Z'),
    new Date('+010000-01-01T00:00:00.000Z'),
  ])('refuses noncanonical effectiveAt %s before any database access', async (effectiveAt) => {
    const executeTx = {
      query: vi.fn(),
      one: vi.fn(),
      maybeOne: vi.fn(),
    } as unknown as Tx;
    const preflightTx = {
      query: vi.fn(),
      one: vi.fn(),
      maybeOne: vi.fn(),
    } as unknown as Tx;
    const execute = createTransactionalDispatcher({
      allowedActions: new Set([PURE_TRANSITION_REQUEST.actionType]),
    });
    const preflight = createTransactionalPreflight({
      allowedActions: new Set([PURE_TRANSITION_REQUEST.actionType]),
    });
    const request = { ...PURE_TRANSITION_REQUEST, effectiveAt };

    await expect(execute(executeTx, request)).rejects.toMatchObject({
      failure: 'precondition_failed',
      message: expect.stringMatching(/four-digit-year RFC 3339 millisecond instant/),
    });
    await expect(preflight(preflightTx, request)).rejects.toMatchObject({
      failure: 'precondition_failed',
      message: expect.stringMatching(/four-digit-year RFC 3339 millisecond instant/),
    });
    expect(executeTx.query).not.toHaveBeenCalled();
    expect(preflightTx.query).not.toHaveBeenCalled();
  });

  it('refuses a registry action with zero configured owners before any authoritative write', async () => {
    const query = vi.fn();
    const tx = { query, one: vi.fn(), maybeOne: vi.fn() } as unknown as Tx;
    const execute = createTransactionalDispatcher({ allowedActions: new Set() });

    await expect(execute(tx, PURE_TRANSITION_REQUEST)).rejects.toEqual(
      expect.objectContaining({ failure: 'unknown_action' }),
    );

    expect(query).not.toHaveBeenCalled();
    expect(tx.one as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(tx.maybeOne as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('executes an explicitly owned pure transition without fabricating a handler', async () => {
    const boundary = dispatcherTx();
    const execute = createTransactionalDispatcher({
      allowedActions: new Set([PURE_TRANSITION_REQUEST.actionType]),
    });

    const result = await execute(boundary.tx, PURE_TRANSITION_REQUEST);

    expect(result).toMatchObject({ status: 'applied', replayed: false });
    expect(boundary.statements.some((sql) => /update core\.object/i.test(sql))).toBe(true);
    expect(boundary.statements.some((sql) => /insert into core\.action/i.test(sql))).toBe(true);
    expect(boundary.statements.some((sql) => /insert into core\.audit_event/i.test(sql))).toBe(
      true,
    );
    expect(boundary.statements.some((sql) => /insert into core\.outbox/i.test(sql))).toBe(true);
    expect(boundary.accessContexts).toEqual([
      [PURE_TRANSITION_REQUEST.organizationId, PURE_TRANSITION_REQUEST.maxClassification],
    ]);
  });

  it('acquires the global audit lock only after typed effects finish', async () => {
    const boundary = dispatcherTx();
    let effectFinished = false;
    const originalQuery = boundary.tx.query.bind(boundary.tx);
    boundary.tx.query = (async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('kf:audit-chain:v1')) expect(effectFinished).toBe(true);
      return originalQuery(sql, params);
    }) as Tx['query'];
    const execute = createTransactionalDispatcher({
      allowedActions: new Set([PURE_TRANSITION_REQUEST.actionType]),
      effects: {
        [PURE_TRANSITION_REQUEST.actionType]: async () => {
          effectFinished = true;
        },
      },
    });

    await execute(boundary.tx, {
      ...PURE_TRANSITION_REQUEST,
      idempotencyKey: 'test-audit-lock-order-0001',
    });

    expect(effectFinished).toBe(true);
  });

  it('does not replay an action for a different actor or role', async () => {
    const query = vi.fn(async () => []);
    const tx = {
      query,
      one: vi.fn(),
      maybeOne: vi.fn(async (sql: string) => {
        if (sql.includes('registry.action_type')) {
          return { id: PURE_TRANSITION_REQUEST.actionType, transactional: true };
        }
        if (sql.includes('org.holds_role')) return { ok: true };
        if (sql.includes('org.resolve_effective_classification'))
          return { requested_classification: PURE_TRANSITION_REQUEST.maxClassification };
        if (sql.includes('from core.action')) {
          return {
            ...replayReceipt(),
            actor_id: '99999999-9999-7999-8999-999999999999',
          };
        }
        return undefined;
      }),
    } as unknown as Tx;
    const execute = createTransactionalDispatcher({
      allowedActions: new Set([PURE_TRANSITION_REQUEST.actionType]),
    });

    await expect(execute(tx, PURE_TRANSITION_REQUEST)).rejects.toEqual(
      expect.objectContaining({ failure: 'actor_not_authorized' }),
    );
    expect(tx.one as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('replays only an identical canonical semantic request', async () => {
    const prior = replayReceipt();
    const tx = {
      query: vi.fn(async () => []),
      one: vi.fn(),
      maybeOne: vi.fn(async (sql: string) =>
        sql.includes('registry.action_type')
          ? { id: PURE_TRANSITION_REQUEST.actionType, transactional: true }
          : sql.includes('org.holds_role')
            ? { ok: true }
            : sql.includes('org.resolve_effective_classification')
              ? { requested_classification: PURE_TRANSITION_REQUEST.maxClassification }
              : sql.includes('from core.action')
                ? prior
                : undefined,
      ),
    } as unknown as Tx;
    const execute = createTransactionalDispatcher({
      allowedActions: new Set([PURE_TRANSITION_REQUEST.actionType]),
    });

    await expect(
      execute(tx, {
        ...PURE_TRANSITION_REQUEST,
        requestId: 'retry-transport-request',
        maxClassification: 'confidential',
      }),
    ).resolves.toEqual({
      actionId: prior.id,
      status: 'applied',
      replayed: true,
      objectIds: prior.target_ids,
      auditDigest: prior.audit_digest,
    });
    expect(tx.one as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('rejects idempotency-key reuse with different mutation semantics', async () => {
    const tx = {
      query: vi.fn(async () => []),
      one: vi.fn(),
      maybeOne: vi.fn(async (sql: string) =>
        sql.includes('registry.action_type')
          ? { id: PURE_TRANSITION_REQUEST.actionType, transactional: true }
          : sql.includes('org.holds_role')
            ? { ok: true }
            : sql.includes('org.resolve_effective_classification')
              ? { requested_classification: PURE_TRANSITION_REQUEST.maxClassification }
              : sql.includes('from core.action')
                ? replayReceipt()
                : undefined,
      ),
    } as unknown as Tx;
    const execute = createTransactionalDispatcher({
      allowedActions: new Set([PURE_TRANSITION_REQUEST.actionType]),
    });

    await expect(
      execute(tx, { ...PURE_TRANSITION_REQUEST, payload: { to_state: 'cancelled' } }),
    ).rejects.toEqual(expect.objectContaining({ failure: 'idempotency_conflict' }));
    expect(tx.one as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('refuses replay when authoritative action status or audit identity is inconsistent', async () => {
    for (const prior of [
      { ...replayReceipt(), result_status: 'failed' },
      { ...replayReceipt(), event_actor_id: '99999999-9999-7999-8999-999999999999' },
    ]) {
      const tx = {
        query: vi.fn(async () => []),
        one: vi.fn(),
        maybeOne: vi.fn(async (sql: string) =>
          sql.includes('registry.action_type')
            ? { id: PURE_TRANSITION_REQUEST.actionType, transactional: true }
            : sql.includes('org.holds_role')
              ? { ok: true }
              : sql.includes('org.resolve_effective_classification')
                ? { requested_classification: PURE_TRANSITION_REQUEST.maxClassification }
                : sql.includes('from core.action')
                  ? prior
                  : undefined,
        ),
      } as unknown as Tx;
      const execute = createTransactionalDispatcher({
        allowedActions: new Set([PURE_TRANSITION_REQUEST.actionType]),
      });

      await expect(execute(tx, PURE_TRANSITION_REQUEST)).rejects.toMatchObject({
        failure: 'precondition_failed',
        message: expect.stringMatching(/inconsistent action or audit receipt/),
      });
      expect(tx.one as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    }
  });

  it('refuses replay when sub-millisecond action and receipt timestamps differ', async () => {
    const prior = {
      ...replayReceipt(),
      event_effective_at_exact: '2026-08-14T12:00:00.000999Z',
    };
    const tx = {
      query: vi.fn(async () => []),
      one: vi.fn(),
      maybeOne: vi.fn(async (sql: string) =>
        sql.includes('registry.action_type')
          ? { id: PURE_TRANSITION_REQUEST.actionType, transactional: true }
          : sql.includes('org.holds_role')
            ? { ok: true }
            : sql.includes('org.resolve_effective_classification')
              ? { requested_classification: PURE_TRANSITION_REQUEST.maxClassification }
              : sql.includes('from core.action')
                ? prior
                : undefined,
      ),
    } as unknown as Tx;
    const execute = createTransactionalDispatcher({
      allowedActions: new Set([PURE_TRANSITION_REQUEST.actionType]),
    });

    await expect(execute(tx, PURE_TRANSITION_REQUEST)).rejects.toMatchObject({
      failure: 'precondition_failed',
      message: expect.stringMatching(/inconsistent action or audit receipt/),
    });
    expect(tx.one as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe('semantic action request identity', () => {
  it('is canonical across object key and target order but excludes transport/read scope', () => {
    const first: ActionRequest = {
      ...PURE_TRANSITION_REQUEST,
      targetIds: ['aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb'],
      payload: { z: 1, nested: { right: true, left: false } },
      requestId: 'transport-one',
      maxClassification: 'internal',
    };
    const retry: ActionRequest = {
      ...first,
      targetIds: [...first.targetIds].reverse(),
      payload: { nested: { left: false, right: true }, z: 1 },
      requestId: 'transport-two',
      maxClassification: 'restricted',
    };

    expect(semanticActionRequestDigest(retry)).toBe(semanticActionRequestDigest(first));
    expect(semanticActionRequestDigest({ ...first, reason: 'different' })).not.toBe(
      semanticActionRequestDigest(first),
    );
    expect(semanticActionRequestDigest({ ...first, organizationId: REQUEST.actorId })).not.toBe(
      semanticActionRequestDigest(first),
    );
    expect(semanticActionRequestDigest({ ...first, expectedVersion: 1 })).not.toBe(
      semanticActionRequestDigest(first),
    );
    expect(
      semanticActionRequestDigest({ ...first, effectiveAt: new Date('2026-08-14T12:00:00.000Z') }),
    ).not.toBe(semanticActionRequestDigest(first));
  });
});
