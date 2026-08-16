import type { CheckFn } from './contracts.js';
import { recoveryObjective } from './recovery-objective.js';

export const pitrReadiness: CheckFn = async (tx) => {
  const objective = await recoveryObjective(tx);
  if (objective === undefined) {
    return {
      id: 'pitr_readiness',
      status: 'failed',
      detail:
        'No recovery objective has been declared, so whether this deployment needs continuous ' +
        'archiving has not been decided.',
    };
  }

  const row = await tx.one<{
    archive_mode: string;
    archived: string;
    failed: string;
    last_failed: Date | null;
    last_archived: Date | null;
  }>(
    `select current_setting('archive_mode') as archive_mode,
            coalesce(archived_count, 0)::text as archived,
            coalesce(failed_count, 0)::text as failed,
            last_failed_time as last_failed,
            last_archived_time as last_archived
       from pg_stat_archiver`,
  );
  const on = row.archive_mode === 'on' || row.archive_mode === 'always';
  const measured = {
    archive_mode: row.archive_mode,
    archived: Number(row.archived),
    failed: Number(row.failed),
    required: objective.requires_pitr ? 'yes' : 'no',
  };

  if (!objective.requires_pitr) {
    return {
      id: 'pitr_readiness',
      status: 'ok',
      detail:
        `Continuous archiving is not required by the declared objective (recovery point ` +
        `${objective.rpo_seconds}s is met by the backup schedule alone). archive_mode is ` +
        `${row.archive_mode}.`,
      measured,
    };
  }

  if (!on) {
    return {
      id: 'pitr_readiness',
      status: 'failed',
      detail:
        'The declared objective requires point-in-time recovery, and archive_mode is ' +
        `${row.archive_mode}. Recovery is limited to the last full backup, so the real ` +
        'recovery point is the backup interval, not the declared one.',
      measured,
    };
  }

  if (
    row.last_failed !== null &&
    (row.last_archived === null || row.last_failed > row.last_archived)
  ) {
    return {
      id: 'pitr_readiness',
      status: 'failed',
      detail:
        `Continuous archiving is enabled and its most recent attempt FAILED ` +
        `(${Number(row.failed)} failures). WAL is accumulating in pg_wal and will fill the ` +
        'volume; when it does, PostgreSQL stops accepting writes.',
      measured,
    };
  }

  return {
    id: 'pitr_readiness',
    status: 'ok',
    detail: `Continuous archiving is ${row.archive_mode} and its last attempt succeeded.`,
    measured,
  };
};
