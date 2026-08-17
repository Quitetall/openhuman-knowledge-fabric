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
  liminalRuntimeInventory,
  reverseProxyPosture,
  runtimeVersion,
  tlsTermination,
} from './host.js';
import { secretPosture, unitProvenance } from './units.js';

/**
 * A check for most blockers in `docs/deployment/private-host.md`, in the order an operator
 * meets them: what is installed, what it can read, how it is reached, who it trusts, what it
 * runs on, and what somebody proved by doing it.
 *
 * NOT one per blocker, which this comment once claimed. Two still have no check at all, and
 * neither can be closed from here: real-provider browser evidence, and a person actually
 * receiving an alert. Both need a human. (`reverse_proxy_posture` and
 * `liminal_runtime_inventory` closed two others on 2026-08-17; firewall rules remain part of
 * an otherwise-covered bullet.) The document marks each uncovered one explicitly, and
 * `tests/deployment/commissioning-blockers.test.ts` holds the two lists together so a blocker
 * cannot silently acquire the appearance of coverage.
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
    id: 'reverse_proxy_posture',
    blocker:
      'no installed nginx validation: upstream TLS termination is asserted by the deployment ' +
      'and, until this passes, verified by nobody',
    run: reverseProxyPosture,
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
    id: 'liminal_runtime_inventory',
    blocker:
      'no proof that the compiler and external runtime closure on this host are the reviewed ' +
      'bytes rather than whatever was installed since',
    run: liminalRuntimeInventory,
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
