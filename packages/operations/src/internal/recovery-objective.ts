import type { Tx } from '@kf/database';
import type { RecoveryObjective } from './contracts.js';

export async function recoveryObjective(tx: Tx): Promise<RecoveryObjective | undefined> {
  return tx.maybeOne<RecoveryObjective>(
    `select rpo_seconds, rto_seconds, restore_drill_days, requires_pitr, declared_at
       from ops.recovery_objective
      order by declared_at desc, id desc
      limit 1`,
  );
}
