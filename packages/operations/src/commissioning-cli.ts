/**
 * Commissioning, from a terminal on the host.
 *
 *   kf-commissioning                    show every check
 *   kf-commissioning --json             the same, as JSON, for an evidence record
 *   kf-commissioning --send-test-alert  send one real alert, then ask a person if it arrived
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

import { spawn } from 'node:child_process';
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

/**
 * Send one real alert down the configured path, so a person can say whether it arrived.
 *
 * This is the only blocker in `private-host.md` that no automated check can close, and the
 * reason is worth stating where the code is: `kf-alert@.service` is tested against a real
 * HTTPS endpoint, refuses cleartext, refuses a group-readable URL file and exits non-zero when
 * the endpoint will not take it — and every one of those passes with a webhook URL pointing at
 * a channel nobody reads. "Delivered" and "received" are different claims and only the second
 * one matters at 03:00.
 *
 * DELIBERATELY NOT PART OF THE NORMAL RUN. `kf-commissioning` is safe to run repeatedly, from
 * a timer, by anyone; an alert has a human on the other end of it. A check that pages somebody
 * every time it is assessed teaches them to ignore it, which would break the control it is
 * supposed to be establishing.
 *
 * It does not and cannot report success. It reports that a message was accepted by the
 * endpoint, and then tells the operator what they have to do next, which is ask a person.
 */
async function sendTestAlert(): Promise<number> {
  const script = optional('KF_ALERT_DISPATCH') ?? '/opt/kf/scripts/alert-dispatch.sh';
  console.warn(`Sending one test alert via ${script} ...\n`);

  const code = await new Promise<number>((resolve) => {
    const child = spawn('bash', [script, 'failure', 'kf-commissioning-test.service'], {
      stdio: 'inherit',
    });
    child.on('close', (status) => resolve(status ?? 1));
  });

  if (code !== 0) {
    console.warn(
      '\nThe alert was NOT accepted by the endpoint. This is the good failure: it is visible ' +
        'here rather than at 03:00. Fix the webhook URL or the endpoint and run this again.',
    );
    return code;
  }

  console.warn(
    [
      '',
      'The endpoint accepted the alert. That is all this program can establish.',
      '',
      'It has NOT verified that a person received it. A webhook URL that is wrong, revoked or',
      'pointed at an abandoned channel accepts a POST and reaches nobody, which is exactly the',
      'failure this step exists to catch.',
      '',
      'Now: ask the person who is meant to receive alerts whether one arrived, naming',
      '`kf-commissioning-test.service`. Record their answer in the commissioning evidence.',
      'Until somebody says yes, the blocker in docs/deployment/private-host.md stays open.',
    ].join('\n'),
  );
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes('--send-test-alert')) return sendTestAlert();

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
    ...(optional('KF_REVERSE_PROXY_CONFIG') === undefined
      ? {}
      : { reverseProxyConfigPath: optional('KF_REVERSE_PROXY_CONFIG')! }),
    ...(optional('KF_RELEASE_DIR') === undefined
      ? {}
      : { releaseDirectory: optional('KF_RELEASE_DIR')! }),
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
