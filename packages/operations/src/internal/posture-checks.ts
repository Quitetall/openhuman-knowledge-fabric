import type { CheckFn } from './contracts.js';

/**
 * The live server runs with JIT off (KF-SAS-RQ-076).
 *
 * `deploy/postgres/planner.conf`, `docker-compose.yml` and the test harness all set it, and a
 * parity test holds those three files together. None of that reaches a host whose cluster never
 * included the file, or a database- or role-level override for this login: that server runs the
 * configuration measured 8 to 14 times slower on unbounded scans under row security, while every
 * test describes one nobody is running. This reads the setting the session actually has.
 */
export const plannerSettings: CheckFn = async (tx) => {
  const row = await tx.one<{ jit: string; source: string | null }>(
    `select current_setting('jit') as jit,
            (select source from pg_settings where name = 'jit') as source`,
  );
  const ok = row.jit === 'off';
  return {
    id: 'planner_settings',
    status: ok ? 'ok' : 'failed',
    detail: ok
      ? 'JIT is off, as deploy/postgres/planner.conf, compose and the test harness all declare.'
      : `JIT is ${row.jit} (set from ${row.source ?? 'an unknown source'}). Row-level security ` +
        'inflates planner estimates past jit_above_cost, measured 8-14x slower; install ' +
        'deploy/postgres/planner.conf and remove any database or role override.',
    measured: { jit: row.jit, source: row.source },
  };
};

/**
 * The running database's row security matches what the migrations declare (KF-SAS-RQ-186):
 * every table that enables it forces it, and every table without it is in the declared
 * exemption list. Anything else was created or altered outside the reviewed migration set.
 */
export const rowSecurityReconciled: CheckFn = async (tx) => {
  const rows = await tx.query<{ table_name: string; problem: string }>(
    'select table_name, problem from core.readiness_unforced_row_security()',
  );
  if (rows.length === 0) {
    return {
      id: 'row_security_reconciled',
      status: 'ok',
      detail:
        'Every table forces the row-level security it enables, and every table without it is declared exempt.',
      measured: { differences: 0 },
    };
  }
  const shown = rows
    .slice(0, 10)
    .map((row) => `${row.table_name} (${row.problem})`)
    .join(', ');
  return {
    id: 'row_security_reconciled',
    status: 'failed',
    detail:
      `${rows.length} table(s) differ from the row security the migrations declare: ${shown}` +
      `${rows.length > 10 ? ', …' : ''}. A login inheriting the owner, or any login granted the ` +
      'table, may read rows no policy scopes.',
    measured: {
      differences: rows.length,
      enabledNotForced: rows.filter((row) => row.problem === 'enabled_not_forced').length,
      undeclared: rows.filter((row) => row.problem === 'undeclared_without_row_security').length,
    },
  };
};
