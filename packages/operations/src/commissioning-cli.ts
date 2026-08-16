/**
 * Commissioning, from a terminal on the host.
 *
 *   kf-commissioning              show every check
 *   kf-commissioning --json       the same, as JSON, for an evidence record
 *
 * Exit status is 0 only when every check is satisfied. `unverifiable` exits non-zero exactly
 * as `unsatisfied` does: "we could not look" is not a pass, and the whole reason this program
 * exists is that `docs/deployment/private-host.md` must not be citable as proof of something
 * nobody checked.
 *
 * Configuration comes from the environment because that is what a systemd unit and an
 * operator's shell both have. Nothing is inferred: a value nobody supplied makes its check
 * `unverifiable` and says which value was missing.
 */

import { assessCommissioning, formatCommissioning } from './index.js';
import type { CommissioningInputs } from './index.js';

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function positiveDays(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of days, got ${raw}`);
  }
  return value;
}

async function main(): Promise<number> {
  const inputs: Partial<CommissioningInputs> = {
    ...(optional('KF_SYSTEMD_DIR') === undefined
      ? {}
      : { systemdDirectory: optional('KF_SYSTEMD_DIR')! }),
    ...(optional('KF_SHIPPED_UNIT_DIR') === undefined
      ? {}
      : { shippedUnitDirectory: optional('KF_SHIPPED_UNIT_DIR')! }),
    ...(optional('KF_PUBLIC_HOSTNAME') === undefined
      ? {}
      : { publicHostname: optional('KF_PUBLIC_HOSTNAME')! }),
    ...(optional('KF_TLS_CERTIFICATE') === undefined
      ? {}
      : { tlsCertificatePath: optional('KF_TLS_CERTIFICATE')! }),
    ...(optional('KF_TLS_PRIVATE_KEY') === undefined
      ? {}
      : { tlsPrivateKeyPath: optional('KF_TLS_PRIVATE_KEY')! }),
    ...(optional('KF_IDENTITY_ISSUER') === undefined
      ? {}
      : { identityIssuer: optional('KF_IDENTITY_ISSUER')! }),
    ...(optional('KF_IDENTITY_CLIENT_ID') === undefined
      ? {}
      : { identityClientId: optional('KF_IDENTITY_CLIENT_ID')! }),
    ...(optional('KF_IDENTITY_POLICY') === undefined
      ? {}
      : { identityPolicyPath: optional('KF_IDENTITY_POLICY')! }),
    ...(optional('KF_IDENTITY_POLICY_SHA256') === undefined
      ? {}
      : { identityPolicyDigest: optional('KF_IDENTITY_POLICY_SHA256')! }),
    ...(optional('KF_EVIDENCE_DIR') === undefined
      ? {}
      : { evidenceDirectory: optional('KF_EVIDENCE_DIR')! }),
    ...(optional('KF_RELEASE_ID') === undefined ? {} : { releaseId: optional('KF_RELEASE_ID')! }),
    ...(optional('KF_EXPECTED_NODE_VERSION') === undefined
      ? {}
      : { expectedNodeVersion: optional('KF_EXPECTED_NODE_VERSION')! }),
    certificateRenewalDays: positiveDays('KF_CERTIFICATE_RENEWAL_DAYS', 21),
    rollbackRehearsalDays: positiveDays('KF_ROLLBACK_REHEARSAL_DAYS', 180),
  };

  const report = await assessCommissioning(inputs);
  if (process.argv.includes('--json')) {
    console.warn(JSON.stringify(report, null, 2));
  } else {
    console.warn(formatCommissioning(report));
  }
  return report.commissioned ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // A commissioning check that cannot run leaves the host uncommissioned. Reported the same
    // way a failed check is, so a scheduler and a person read it identically.
    console.error(
      `commissioning could not be assessed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  },
);
