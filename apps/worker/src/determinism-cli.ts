/**
 * `kf-compiler-determinism.service`: re-run the newest recorded compilation successes and fail
 * when one does not reproduce (SAS §100.35, KF-SAS-RQ-102). Read-only; see
 * `compiler-runtime/determinism.ts` for what it compares and what it does not cover.
 *
 * Usage: node dist/determinism-cli.js [--limit N]   (N from 1 to 100; default 5)
 *
 * Exit 0 when every run re-run reproduced (including when there was none to re-run, which it
 * says), 1 on any finding or refusal — which fails the unit and reaches a person through
 * OnFailure=.
 */

import { createPool, withTransaction } from '@kf/database';
import { redact } from '@kf/operations';
import { compilerEnvironment } from './compiler-environment.js';
import { rerunRecordedCompilations } from './compiler-runtime.js';
import { workerDatabaseUrl } from './config.js';

const DEFAULT_LIMIT = 5;

export function determinismLimit(argv: readonly string[]): number {
  if (argv.length === 0) return DEFAULT_LIMIT;
  if (argv.length !== 2 || argv[0] !== '--limit' || !/^[1-9][0-9]{0,2}$/.test(argv[1]!)) {
    throw new Error('usage: determinism-cli [--limit N]');
  }
  const limit = Number(argv[1]);
  if (limit > 100) throw new Error('usage: determinism-cli [--limit N] with N from 1 to 100');
  return limit;
}

async function main(): Promise<void> {
  const limit = determinismLimit(process.argv.slice(2));
  const connectionString = workerDatabaseUrl();
  if (connectionString === undefined) throw new Error('no worker database URL is configured');
  const pool = createPool({ connectionString, maxConnections: 2 });
  try {
    const environment = await compilerEnvironment(pool);
    if (environment === undefined) {
      throw new Error('document compilation is not configured on this host (no LIMINAL_* setting)');
    }
    const sampled = await withTransaction(pool, (tx) =>
      tx.query<{ request_action_id: string }>(
        'select request_action_id from content.compilation_determinism_sample($1)',
        [limit],
      ),
    );
    const report = await rerunRecordedCompilations({
      ...environment,
      actionIds: sampled.map((row) => row.request_action_id),
    });
    process.stdout.write(
      `${JSON.stringify({
        level: report.findings.length === 0 ? 'info' : 'error',
        msg:
          report.checked.length === 0
            ? 'compiler determinism: no recorded success to re-run'
            : `compiler determinism: ${String(report.checked.length)} run(s) re-run, ` +
              `${String(report.findings.length)} did not reproduce`,
        findings: report.findings.map((finding) => ({
          ...finding,
          detail: redact(finding.detail),
        })),
      })}\n`,
    );
    if (report.findings.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('determinism-cli.js') === true) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'compiler determinism re-run refused',
        error: redact(error instanceof Error ? error.message : String(error)),
      }),
    );
    process.exitCode = 1;
  });
}
