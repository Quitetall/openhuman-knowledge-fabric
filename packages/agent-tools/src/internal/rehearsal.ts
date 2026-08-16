import { createDispatcher, type ActionRequest, ActionRejected } from '@kf/actions';
import { withTransaction, type Pool, type Tx } from '@kf/database';
import type { AgentScope } from './types.js';

export interface Rehearsal {
  readonly wouldSucceed: boolean;
  readonly refusal?: {
    readonly failure: string;
    readonly message: string;
    readonly detail: unknown;
  };
  readonly wouldMove: readonly {
    readonly objectId: string;
    readonly from: string;
    readonly to: string;
  }[];
  readonly wouldCreate: number;
}

class RollbackRehearsal extends Error {
  readonly outcome: Rehearsal;
  constructor(outcome: Rehearsal) {
    super('rehearsal complete');
    this.outcome = outcome;
  }
}

export async function rehearseAction(
  pool: Pool,
  scope: AgentScope,
  request: Omit<ActionRequest, 'organizationId' | 'maxClassification' | 'actorId' | 'actingRoleId'>,
  dispatcherOptions: Parameters<typeof createDispatcher>[1] = {},
): Promise<Rehearsal> {
  const full: ActionRequest = {
    ...request,
    actorId: scope.actorId,
    actingRoleId: scope.actingRoleId,
    organizationId: scope.organizationId,
    maxClassification: scope.maxClassification,
  };
  try {
    await withTransaction(pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        scope.organizationId,
        scope.maxClassification,
      ]);
      const before = await stateSnapshot(tx, full.targetIds);
      const execute = createDispatcher(singleTransactionPool(tx), dispatcherOptions);
      const result = await execute(full);
      const after = await stateSnapshot(tx, result.objectIds);
      const wouldMove = [...after.entries()]
        .filter(([id, to]) => before.get(id) !== undefined && before.get(id) !== to)
        .map(([id, to]) => ({ objectId: id, from: before.get(id)!, to }));
      throw new RollbackRehearsal({
        wouldSucceed: true,
        wouldMove,
        wouldCreate: result.objectIds.length - full.targetIds.length,
      });
    });
  } catch (err: unknown) {
    if (err instanceof RollbackRehearsal) return err.outcome;
    if (err instanceof ActionRejected) {
      return {
        wouldSucceed: false,
        refusal: { failure: err.failure, message: err.message, detail: err.detail },
        wouldMove: [],
        wouldCreate: 0,
      };
    }
    return {
      wouldSucceed: false,
      refusal: {
        failure: 'rehearsal_failed',
        message: err instanceof Error ? err.message : String(err),
        detail: null,
      },
      wouldMove: [],
      wouldCreate: 0,
    };
  }
  throw new Error('rehearsal did not roll back — refusing to report a result');
}

async function stateSnapshot(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.query<{ id: string; lifecycle_state: string }>(
    'select id, lifecycle_state from core.object where id = any($1::uuid[])',
    [[...ids]],
  );
  return new Map(rows.map((r) => [r.id, r.lifecycle_state]));
}

const REHEARSAL_SAVEPOINT = 'kf_rehearsal';
const TRANSACTION_CONTROL =
  /^(begin|start\s+transaction|commit|end|rollback|savepoint|release|set\s+transaction|abort)\b/;

function singleTransactionPool(tx: Tx): Pool {
  const control = async (sql: string): Promise<Record<string, unknown>[]> => {
    const verb = sql.trim().toLowerCase();
    if (/^begin\b/.test(verb) || /^start\s+transaction\b/.test(verb)) {
      return tx.query(`savepoint ${REHEARSAL_SAVEPOINT}`);
    }
    if (/^(commit|end)\b/.test(verb)) return [];
    if (/^(rollback|abort)\b/.test(verb)) {
      return tx.query(`rollback to savepoint ${REHEARSAL_SAVEPOINT}`);
    }
    if (TRANSACTION_CONTROL.test(verb)) {
      throw new Error(
        `rehearsal refuses transaction control it cannot safely translate: ${sql.trim().slice(0, 60)}`,
      );
    }
    return tx.query(sql);
  };
  return {
    connect: async () => ({
      query: async (sql: string, params?: readonly unknown[]) => {
        const rows = TRANSACTION_CONTROL.test(sql.trim().toLowerCase())
          ? await control(sql)
          : await tx.query(sql, params ?? []);
        return { rows };
      },
      release: () => {},
    }),
    end: async () => {},
  } as unknown as Pool;
}
