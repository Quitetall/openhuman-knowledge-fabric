import type { CheckFn } from './contracts.js';
import { recoveryObjective } from './recovery-objective.js';

export const backupFreshness: CheckFn = async (tx) => {
  const objective = await recoveryObjective(tx);
  if (objective === undefined) {
    return {
      id: 'backup_freshness',
      status: 'failed',
      detail:
        'No recovery objective has been declared, so no backup schedule can be called ' +
        'sufficient or insufficient. Declare one in ops.recovery_objective — how much work ' +
        'this organization has decided it can afford to lose, and why.',
    };
  }
  if (objective.rto_seconds === null) {
    return {
      id: 'backup_freshness',
      status: 'failed',
      detail:
        'The current recovery objective has no recovery time target. Declare a new row with ' +
        'rto_seconds; a restore with no time limit cannot establish operational readiness.',
      measured: { rpo_seconds: objective.rpo_seconds, rto_seconds: null },
    };
  }

  const row = await tx.maybeOne<{
    location: string;
    age_seconds: string;
    offsite: boolean;
    id: string;
    drill_age_days: string | null;
    last_recovery_seconds: number | null;
    last_outcome: string | null;
    last_database_verified: boolean | null;
    last_checkpoint_verified: boolean | null;
    last_object_store_verified: boolean | null;
  }>(
    `select b.id,
            b.location,
            extract(epoch from now() - b.finished_at)::bigint::text as age_seconds,
            exists (select 1 from ops.backup_copy c
                     where c.backup_run_id = b.id and c.offsite) as offsite,
            (select extract(days from now() - max(d.verified_at))::bigint::text
               from ops.restore_drill d
              where d.outcome = 'verified') as drill_age_days,
            (select d.recovery_seconds from ops.restore_drill d
              where d.outcome = 'verified'
              order by d.verified_at desc, d.id desc limit 1) as last_recovery_seconds,
            (select d.outcome from ops.restore_drill d
              order by d.verified_at desc, d.id desc limit 1) as last_outcome,
            (select d.database_verified from ops.restore_drill d
              order by d.verified_at desc, d.id desc limit 1) as last_database_verified,
            (select d.checkpoint_verified from ops.restore_drill d
              order by d.verified_at desc, d.id desc limit 1) as last_checkpoint_verified,
            (select d.object_store_verified from ops.restore_drill d
              order by d.verified_at desc, d.id desc limit 1) as last_object_store_verified
       from ops.backup_run b
      order by b.finished_at desc, b.id desc
      limit 1`,
  );

  if (row === undefined) {
    return {
      id: 'backup_freshness',
      status: 'failed',
      detail:
        'No backup has ever been recorded. Everything in this database exists in exactly one ' +
        'place. Run scripts/backup.sh.',
      measured: { rpo_seconds: objective.rpo_seconds },
    };
  }

  const ageSeconds = Number(row.age_seconds);
  const drillAgeDays = row.drill_age_days === null ? null : Number(row.drill_age_days);
  const measured = {
    age_seconds: ageSeconds,
    rpo_seconds: objective.rpo_seconds,
    rto_seconds: objective.rto_seconds,
    restore_drill_days: objective.restore_drill_days,
    last_backup: row.location,
    last_drill_age_days: drillAgeDays,
    last_recovery_seconds: row.last_recovery_seconds,
    last_restore_outcome: row.last_outcome,
    last_database_verified:
      row.last_database_verified === null ? null : row.last_database_verified ? 'yes' : 'no',
    last_checkpoint_verified:
      row.last_checkpoint_verified === null ? null : row.last_checkpoint_verified ? 'yes' : 'no',
    last_object_store_verified:
      row.last_object_store_verified === null
        ? null
        : row.last_object_store_verified
          ? 'yes'
          : 'no',
  };

  if (ageSeconds > objective.rpo_seconds) {
    return {
      id: 'backup_freshness',
      status: 'failed',
      detail:
        `The most recent backup finished ${Math.floor(ageSeconds / 60)} minutes ago, against a ` +
        `declared objective of ${Math.floor(objective.rpo_seconds / 60)}. Work done since then ` +
        'would be lost. Either the schedule is not running or the objective is one nobody ' +
        'intends to meet — both are worth knowing.',
      measured,
    };
  }
  if (!row.offsite) {
    return {
      id: 'backup_freshness',
      status: 'degraded',
      detail:
        'The most recent backup is not recorded as off-site. A backup on the same host as the ' +
        'database survives a dropped table and not a lost host, and the second one is the ' +
        'reason backups exist.',
      measured,
    };
  }
  if (row.last_outcome === 'partial') return partialRestore(row, measured);
  if (row.last_outcome === 'failed') return failedRestore(measured);
  return drillReadiness(
    row,
    {
      restore_drill_days: objective.restore_drill_days,
      rto_seconds: objective.rto_seconds,
    },
    drillAgeDays,
    measured,
  );
};

function partialRestore(
  row: {
    last_database_verified: boolean | null;
    last_checkpoint_verified: boolean | null;
    last_object_store_verified: boolean | null;
  },
  measured: Readonly<Record<string, number | string | null>>,
) {
  const missing = [
    !row.last_database_verified ? 'database round-trip' : undefined,
    !row.last_checkpoint_verified ? 'checkpoint trust' : undefined,
    !row.last_object_store_verified ? 'object-store bytes' : undefined,
  ].filter((dimension): dimension is string => dimension !== undefined);
  return {
    id: 'backup_freshness',
    status: 'failed' as const,
    detail:
      `The most recent restore drill is PARTIAL; missing proof: ${missing.join(', ')}. ` +
      'Database recovery alone cannot establish complete Knowledge Fabric recovery.',
    measured,
  };
}

function failedRestore(measured: Readonly<Record<string, number | string | null>>) {
  return {
    id: 'backup_freshness',
    status: 'failed' as const,
    detail:
      'The most recent restore drill FAILED. An earlier one may have succeeded; something ' +
      'changed between them and the latest evidence controls readiness.',
    measured,
  };
}

function drillReadiness(
  row: { last_recovery_seconds: number | null },
  objective: { rto_seconds: number; restore_drill_days: number },
  drillAgeDays: number | null,
  measured: Readonly<Record<string, number | string | null>>,
) {
  if (drillAgeDays === null) {
    return {
      id: 'backup_freshness',
      status: 'degraded' as const,
      detail:
        'Backups are current, but none has ever been restored. A backup is not valid until it ' +
        'has been restored — run scripts/restore-verify.sh against a scratch database.',
      measured,
    };
  }
  if (drillAgeDays > objective.restore_drill_days) {
    return {
      id: 'backup_freshness',
      status: 'degraded' as const,
      detail:
        `The last successful restore drill was ${drillAgeDays} days ago, against a declared ` +
        `interval of ${objective.restore_drill_days}. It proved a schema and a tool chain that ` +
        'may no longer be the ones in use.',
      measured,
    };
  }
  if (row.last_recovery_seconds === null) {
    return {
      id: 'backup_freshness',
      status: 'failed' as const,
      detail:
        'The last verified restore did not record elapsed recovery time, so it cannot prove ' +
        `the declared ${objective.rto_seconds}-second recovery time objective.`,
      measured,
    };
  }
  if (row.last_recovery_seconds > objective.rto_seconds) {
    return {
      id: 'backup_freshness',
      status: 'failed' as const,
      detail:
        `The last verified recovery took ${row.last_recovery_seconds} seconds, against a ` +
        `declared recovery time objective of ${objective.rto_seconds} seconds.`,
      measured,
    };
  }
  return {
    id: 'backup_freshness',
    status: 'ok' as const,
    detail:
      'Backups meet the declared recovery point and recovery time objectives, are off-site, ' +
      'and a recent one has database, checkpoint-trust, and object-store recovery proofs.',
    measured,
  };
}
