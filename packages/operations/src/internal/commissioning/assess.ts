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
 * A check for most blockers in `docs/deployment/private-host.md`, in the order an operator
 * meets them: what is installed, what it can read, how it is reached, who it trusts, what it
 * runs on, and what somebody proved by doing it.
 *
 * NOT one per blocker, which this comment used to claim. Four of them have no check at all —
 * real-provider browser evidence, firewall and nginx validation, `kf-alert@` actually reaching
 * a person, and the reviewed Liminal artifact and runtime-closure inventory. The document marks
 * each of those explicitly, and `tests/deployment/commissioning-blockers.test.ts` holds the two
 * lists together so a blocker cannot silently acquire the appearance of coverage.
 *
 * Each `blocker` string is the operator-facing restatement of what is still missing when the
 * check does not pass. Keep it describing the GAP, not the mechanism — it is printed next to a
 * failing check, where "what is still not proven" is the useful sentence.
 */
export const COMMISSIONING_CHECKS: readonly CommissioningCheckDefinition[] = [
  {
    id: 'unit_provenance',
    blocker:
      'no installed user/file ownership evidence, service start/restart/reboot evidence; ' +
      'no proof that units sharing an identity need the same secrets',
    run: unitProvenance,
  },
  {
    id: 'secret_posture',
    blocker:
      'no host evidence that each private key is readable only by the one identity that uses it',
    run: secretPosture,
  },
  {
    id: 'tls_termination',
    blocker: 'no site hostnames or certificates validated against the name this host serves',
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
