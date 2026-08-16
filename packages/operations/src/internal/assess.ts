import { withTransaction, type Pool } from '@kf/database';
import { INSTITUTIONAL_CHECKS, SERVICE_CHECKS } from './checks.js';
import {
  DEFAULTS,
  type Check,
  type CheckDefinition,
  type ReadinessPartition,
  type ReadinessReport,
  type ReadinessThresholds,
} from './contracts.js';

/**
 * Run every check and keep service capability separate from institutional authority.
 *
 * Each check receives its own transaction. One broken query therefore becomes one named
 * `unknown`; it cannot poison later checks or the other readiness partition. `unknown` still
 * fails its own partition closed.
 */
export async function assessReadiness(
  pool: Pool,
  thresholds: ReadinessThresholds = {},
): Promise<ReadinessReport> {
  const limits = { ...DEFAULTS, ...thresholds };

  const service = await assessPartition(pool, SERVICE_CHECKS, limits);
  const institutional = await assessPartition(pool, INSTITUTIONAL_CHECKS, limits);

  return {
    // These aliases have one unambiguous meaning: readiness to serve. Institutional blockers
    // remain visible below but cannot silently turn a capable dogfood service red.
    ready: service.ready,
    checks: service.checks,
    service,
    institutional,
  };
}

async function assessPartition(
  pool: Pool,
  definitions: readonly CheckDefinition[],
  limits: Required<ReadinessThresholds>,
): Promise<ReadinessPartition> {
  const checks: Check[] = [];
  for (const definition of definitions) {
    try {
      const result = await withTransaction(pool, (tx) => definition.run(tx, limits));
      if (result.id !== definition.id) {
        throw new Error(`check returned id ${result.id}; expected ${definition.id}`);
      }
      checks.push({ ...result, scope: definition.scope });
    } catch (err: unknown) {
      checks.push({
        id: definition.id,
        scope: definition.scope,
        status: 'unknown',
        detail: `Readiness check ${definition.id} could not run: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { ready: checks.every((check) => check.status === 'ok'), checks };
}
