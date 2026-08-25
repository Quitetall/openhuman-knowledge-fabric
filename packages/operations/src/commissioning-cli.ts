/**
 * Commissioning, from a terminal on the host.
 *
 * Run `kf-commissioning --help` for the invocations and every variable it reads. That text is
 * GENERATED from `internal/commissioning/environment.ts` and used to live here as a comment,
 * where an operator on a host could not see it and where it was free to describe a different
 * program than the one below.
 *
 * Exit status is 0 only when every check is satisfied. `unverifiable` exits non-zero exactly
 * as `unsatisfied` does: "we could not look" is not a pass, and the whole reason this program
 * exists is that `docs/deployment/private-host.md` must not be citable as proof of something
 * nobody checked.
 */

import { spawn } from 'node:child_process';
import { assessCommissioning, formatCommissioning } from './index.js';
import type { CommissioningInputs } from './index.js';
import { stringInputs, usage } from './internal/commissioning/environment.js';
import type { StringInputKey } from './internal/commissioning/environment.js';

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

const FLAGS = ['--json', '--send-test-alert', '--help'] as const;

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  // An unrecognised flag must not be ignored. `--jsn` would otherwise print the human report,
  // exit as usual, and leave somebody believing they had captured an evidence record.
  const unknown = args.filter((arg) => !FLAGS.includes(arg as (typeof FLAGS)[number]));
  if (unknown.length > 0) {
    console.error(`unknown argument${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}\n`);
    console.error(usage());
    return 2;
  }

  // Before this existed, `--help` ran the full assessment and printed NOT COMMISSIONED at
  // somebody who had asked what the program does. It is also the only place the required
  // variables are visible from a terminal, which is where an operator commissioning a host is.
  if (args.includes('--help')) {
    console.warn(usage());
    return 0;
  }

  if (args.includes('--send-test-alert')) return sendTestAlert();

  // Built from the declared table rather than restated here. Fourteen near-identical spreads
  // used to sit in this function, and a variable could be added to one of them and to no
  // document without anything noticing — which is exactly what happened to
  // KF_REVERSE_PROXY_CONFIG and KF_RELEASE_DIR.
  const supplied: Partial<Record<StringInputKey, string>> = {};
  for (const variable of stringInputs()) {
    const value = optional(variable.env);
    if (value !== undefined) supplied[variable.key] = value;
  }

  const inputs: Partial<CommissioningInputs> = {
    ...supplied,
    certificateRenewalDays: positiveDays('KF_CERTIFICATE_RENEWAL_DAYS', 21),
    rollbackRehearsalDays: positiveDays('KF_ROLLBACK_REHEARSAL_DAYS', 180),
  };

  const report = await assessCommissioning(inputs);
  if (args.includes('--json')) {
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
