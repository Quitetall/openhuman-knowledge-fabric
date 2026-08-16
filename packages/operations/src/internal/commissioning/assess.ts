import {
  COMMISSIONING_DEFAULTS,
  type CommissioningCheck,
  type CommissioningCheckDefinition,
  type CommissioningInputs,
  type CommissioningReport,
} from './contracts.js';
import {
  evidenceReceipts,
  identityProviderPolicy,
  runtimeVersion,
  tlsTermination,
} from './host.js';
import { secretPosture, unitProvenance } from './units.js';

/**
 * One check per blocker in `docs/deployment/private-host.md`, in the order an operator meets
 * them: what is installed, what it can read, how it is reached, who it trusts, what it runs
 * on, and what somebody proved by doing it.
 */
export const COMMISSIONING_CHECKS: readonly CommissioningCheckDefinition[] = [
  {
    id: 'unit_provenance',
    blocker:
      'no installed user/file ownership evidence, service start/restart/reboot evidence; ' +
      'scheduled operation units still share `kf` identity',
    run: unitProvenance,
  },
  {
    id: 'secret_posture',
    blocker: 'checkpoint key isolation from API remains a host evidence gate',
    run: secretPosture,
  },
  {
    id: 'tls_termination',
    blocker: 'no site hostnames, certificates, firewall rules or installed nginx validation',
    run: tlsTermination,
  },
  {
    id: 'identity_provider_policy',
    blocker: 'no reviewed reproducible Keycloak realm/client policy',
    run: identityProviderPolicy,
  },
  {
    id: 'runtime_version',
    blocker: 'no proof host uses exact tested Node/PostgreSQL versions',
    run: runtimeVersion,
  },
  {
    id: 'evidence_receipts',
    blocker:
      'no successful disposable-cluster rollback receipt or host migration result for a ' +
      'release; no human-ratified compiler qualification receipt',
    run: evidenceReceipts,
  },
];

/**
 * Assess every check. Any status other than `satisfied` — including `unverifiable` — means the
 * host is not commissioned.
 *
 * Each check is isolated: one that throws becomes one named `unverifiable` rather than
 * stopping the run, because an operator needs the whole list to work from, not the first
 * thing that went wrong.
 */
export async function assessCommissioning(
  inputs: Partial<CommissioningInputs> = {},
): Promise<CommissioningReport> {
  const resolved: CommissioningInputs = { ...COMMISSIONING_DEFAULTS, ...inputs };
  const checks: CommissioningCheck[] = [];

  for (const definition of COMMISSIONING_CHECKS) {
    try {
      const result = await definition.run(resolved);
      checks.push({ id: definition.id, blocker: definition.blocker, ...result });
    } catch (error: unknown) {
      checks.push({
        id: definition.id,
        blocker: definition.blocker,
        status: 'unverifiable',
        detail: `Check ${definition.id} could not run: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    commissioned: checks.every((check) => check.status === 'satisfied'),
    checks,
  };
}

const SYMBOL: Record<CommissioningCheck['status'], string> = {
  satisfied: '  ok',
  unsatisfied: 'FAIL',
  unverifiable: '  ??',
};

export function formatCommissioning(report: CommissioningReport): string {
  const lines: string[] = [];
  lines.push(
    report.commissioned
      ? 'COMMISSIONED — every host check is satisfied.'
      : 'NOT COMMISSIONED — this deployment must not be cited as institutionally authoritative.',
  );
  lines.push('');
  for (const check of report.checks) {
    lines.push(`${SYMBOL[check.status]}  ${check.id}`);
    lines.push(`      ${check.detail}`);
    if (check.status !== 'satisfied') lines.push(`      blocker: ${check.blocker}`);
    for (const [key, value] of Object.entries(check.observed ?? {})) {
      lines.push(`      ${key}: ${String(value)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
