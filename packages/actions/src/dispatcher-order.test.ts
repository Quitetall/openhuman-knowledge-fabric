/**
 * The dispatcher's statement order, pinned by capture (SAS §26, KF-SAS-RQ-051 and -052).
 *
 * The order is load-bearing: a reordering is an authority change. These tests run the real
 * transactional dispatcher over a fake transaction that records every statement in the order
 * it was issued, then assert positions — authority resolved before anything is materialized,
 * targets locked in canonical order, and act coverage asserted only after the lock. A fake is
 * the right tool here and only here: the property is the ORDER of statements the dispatcher
 * issues, which the database would execute whatever it was.
 */

import { describe, expect, it } from 'vitest';
import { GENESIS_DIGEST } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import { PayloadInvalid, requireString } from '@kf/record-atoms';
import {
  ActionRejected,
  createTransactionalDispatcher,
  createTransactionalPreflight,
  type ActionRequest,
  type ObjectRow,
} from './index.js';

const ACTOR = '11111111-1111-7111-8111-111111111111';
const ROLE = '22222222-2222-7222-8222-222222222222';
const ORG = '33333333-3333-7333-8333-333333333333';
const EXISTING = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const CREATED = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const MATERIALIZER = '-- materializer ran';

const REQUEST: ActionRequest = {
  actionType: 'grant_something',
  actorId: ACTOR,
  actingRoleId: ROLE,
  targetIds: [EXISTING],
  idempotencyKey: 'dispatcher-order-0001',
  organizationId: ORG,
  maxClassification: 'internal',
  attestation: 'a7'.repeat(32),
};

function row(id: string): ObjectRow {
  return {
    id,
    object_type: 'thing',
    lifecycle_state: 'open',
    row_version: '0',
    organization_id: ORG,
    created_by: '66666666-6666-7666-8666-666666666666',
  };
}

/** A transaction that answers the dispatcher's statements and records each one in order. */
function recordingTx(requiresAct: boolean) {
  const statements: string[] = [];
  const lockParams: unknown[][] = [];
  const tx = {
    async query(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes('from core.object')) {
        if (sql.includes('for update')) lockParams.push([...(params ?? [])]);
        const ids = (params?.[0] as string[]) ?? [];
        // Deliberately NOT in id order: the dispatcher must not depend on the rows' order.
        return [...ids].reverse().map(row);
      }
      return [];
    },
    async one(sql: string) {
      statements.push(sql);
      if (sql.includes('uuidv7()')) {
        return {
          id: '77777777-7777-7777-8777-777777777777',
          now: new Date('2026-08-14T12:00:00.000Z'),
        };
      }
      if (sql.includes('org.act_grant_reaches')) return { ok: true };
      if (sql.includes('core.audit_chain_head')) return { digest: GENESIS_DIGEST };
      throw new Error(`unexpected one(): ${sql}`);
    },
    async maybeOne(sql: string) {
      statements.push(sql);
      if (sql.includes('registry.action_type')) {
        return {
          id: REQUEST.actionType,
          transactional: true,
          requires_capability: requiresAct ? 'act' : null,
        };
      }
      if (sql.includes('org.holds_role')) return { ok: true };
      if (sql.includes('core.bind_principal')) return { ceiling: REQUEST.maxClassification };
      if (sql.includes('from org.person')) return { person_kind: 'human' };
      if (sql.includes('from core.action')) return undefined;
      if (sql.includes('from core.audit_event')) return undefined;
      throw new Error(`unexpected maybeOne(): ${sql}`);
    },
  } as unknown as Tx;
  return { statements, lockParams, tx };
}

function positionOf(statements: readonly string[], pattern: RegExp): number {
  const index = statements.findIndex((sql) => pattern.test(sql));
  expect(index, `no statement matched ${pattern}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('dispatcher statement order (SAS §26)', () => {
  it('resolves authority before materializing, locks, then asserts act coverage', async () => {
    const boundary = recordingTx(true);
    const execute = createTransactionalDispatcher({
      allowedActions: new Set([REQUEST.actionType]),
      materializers: {
        [REQUEST.actionType]: async (tx) => {
          await tx.query(MATERIALIZER);
          return [CREATED];
        },
      },
    });

    await execute(boundary.tx, REQUEST);

    const at = (pattern: RegExp) => positionOf(boundary.statements, pattern);
    const idempotencyLock = at(/pg_advisory_xact_lock\(hashtextextended\(\$1/);
    const definition = at(/from registry\.action_type/);
    const roleHeld = at(/org\.holds_role/);
    const bind = at(/core\.bind_principal/);
    const replay = at(/from core\.action/);
    const minted = at(/uuidv7\(\)/);
    const materialized = at(new RegExp(MATERIALIZER));
    const locked = at(/from core\.object .*for update/s);
    const actCovered = at(/org\.act_grant_reaches/);
    const acted = at(/insert into core\.action/);
    const audited = at(/insert into core\.audit_event/);

    // Steps 4 → 15 of §26, as positions. Each `<` is one sentence of the SAS.
    expect(idempotencyLock).toBeLessThan(definition);
    expect(definition).toBeLessThan(roleHeld);
    expect(roleHeld).toBeLessThan(bind);
    // KF-SAS-RQ-051, first half: authority is resolved before any state is materialized.
    expect(bind).toBeLessThan(replay);
    expect(replay).toBeLessThan(minted);
    expect(minted).toBeLessThan(materialized);
    expect(materialized).toBeLessThan(locked);
    // KF-SAS-RQ-051, second half: coverage is asserted after the targets are locked, and it
    // covers what the materializer created as well as what the caller named.
    expect(locked).toBeLessThan(actCovered);
    expect(actCovered).toBeLessThan(acted);
    expect(acted).toBeLessThan(audited);
  });

  it('locks targets with an ORDER BY in the statement, not only a sort afterwards (RQ-052)', async () => {
    const boundary = recordingTx(false);
    const execute = createTransactionalDispatcher({
      allowedActions: new Set([REQUEST.actionType]),
    });

    const result = await execute(boundary.tx, {
      ...REQUEST,
      targetIds: [EXISTING, CREATED],
      idempotencyKey: 'dispatcher-order-0002',
    });

    const lock = boundary.statements.filter((sql) => /for update/.test(sql));
    expect(lock).toHaveLength(1);
    // `for update` locks rows in the order the plan emits them; only an ORDER BY in the same
    // statement makes that the canonical id order for every concurrent act.
    expect(lock[0]).toMatch(/\border by id\s+for update\b/);
    expect(result.objectIds).toEqual([EXISTING, CREATED]);
  });
});

describe('dispatcher refusals reach every surface (RQ-012)', () => {
  function payloadDispatcher(effect: () => Promise<void>) {
    return createTransactionalDispatcher({
      allowedActions: new Set([REQUEST.actionType]),
      effects: { [REQUEST.actionType]: effect },
    });
  }

  it('refuses a malformed payload field as precondition_failed naming the field', async () => {
    const execute = payloadDispatcher(async () => {
      requireString({}, 'title');
    });

    const refusal = await execute(recordingTx(false).tx, REQUEST).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(ActionRejected);
    expect(refusal).toMatchObject({
      failure: 'precondition_failed',
      detail: { field: 'title' },
      message: expect.stringMatching(/title is required/),
    });
  });

  it('refuses a trigger-raised rule violation as precondition_failed naming the rule', async () => {
    const execute = payloadDispatcher(async () => {
      const err = new Error('KF-FIN-001: accepted value would exceed the ceiling') as Error & {
        code: string;
      };
      err.code = '23514';
      throw err;
    });

    const refusal = await execute(recordingTx(false).tx, REQUEST).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(ActionRejected);
    expect(refusal).toMatchObject({
      failure: 'precondition_failed',
      detail: { rule: 'KF-FIN-001', enforcedBy: 'database' },
    });
  });

  it.each([
    ['an unrelated database fault', '42P01', 'relation "core.secret_table" does not exist'],
    ['a check_violation that merely mentions a rule', '23514', 'row violates KF-FIN-001 check'],
  ])('leaves %s a fault, not a refusal', async (_label, code, message) => {
    const fault = Object.assign(new Error(message), { code });
    const execute = payloadDispatcher(async () => {
      throw fault;
    });

    await expect(execute(recordingTx(false).tx, REQUEST)).rejects.toBe(fault);
  });

  it('applies the same mapping in preflight', async () => {
    const preflight = createTransactionalPreflight({
      allowedActions: new Set([REQUEST.actionType]),
      preconditions: {
        [REQUEST.actionType]: async () => {
          throw new PayloadInvalid('amount_minor', 'amount_minor is required');
        },
      },
    });
    const boundary = recordingTx(false);
    const refusal = await preflight(boundary.tx, REQUEST).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ActionRejected);
    expect(refusal).toMatchObject({
      failure: 'precondition_failed',
      detail: { field: 'amount_minor' },
    });
  });
});
