/**
 * Every environment variable commissioning reads, declared once.
 *
 * This exists because the list was previously spread across three places that nothing compared:
 * the reading logic in `commissioning-cli.ts`, the invocation block in
 * `docs/deployment/private-host.md`, and an operator's memory. On 2026-08-24 the first two had
 * drifted, and the drift was not cosmetic — `KF_REVERSE_PROXY_CONFIG` and `KF_RELEASE_DIR` were
 * read by two of the eight checks and named nowhere in the deployment contract.
 *
 * An unsupplied input makes its check `unverifiable`, and `unverifiable` fails exactly as
 * `unsatisfied` does. So an operator following that document exactly could not reach 8/8
 * satisfied, and nothing said why: the two checks would report "no reverse-proxy configuration
 * was supplied" and "no release directory was supplied" about variables the document had never
 * mentioned. That is a commissioning-day failure with a documentation cause, which is the most
 * expensive kind — it surfaces when somebody has a terminal open and a host half-built.
 *
 * So the table is the source, `--help` prints it, the CLI reads from it, and
 * `tests/deployment/commissioning-environment.test.ts` holds the document to it.
 */

import { COMMISSIONING_DEFAULTS } from './contracts.js';
import type { CommissioningInputs } from './contracts.js';

/**
 * The string-valued keys of `CommissioningInputs`.
 *
 * Computed rather than listed, so a new string input cannot be declared here with a key that
 * does not exist, and the numeric tunables below cannot be pointed at one by mistake.
 */
export type StringInputKey = {
  [K in keyof CommissioningInputs]-?: CommissioningInputs[K] extends string | undefined ? K : never;
}[keyof CommissioningInputs];

export interface CommissioningVariable {
  /** The environment variable an operator sets. */
  readonly env: string;
  /**
   * The `CommissioningInputs` field it supplies.
   *
   * Absent when the CLI consumes the value itself rather than passing it to a check —
   * `KF_ALERT_DISPATCH` selects a script to run, and no check reads it.
   */
  readonly key?: StringInputKey;
  /** Which check goes `unverifiable` without it, or what it tunes. */
  readonly summary: string;
  /**
   * `required` — a check cannot run without it.
   * `tunable` — has a default, and the default decides verdicts, so it is worth knowing about.
   */
  readonly kind: 'required' | 'tunable';
  /**
   * Where the value comes from when nobody sets it, READ FROM THE CODE that applies it.
   *
   * This is a key into `COMMISSIONING_DEFAULTS` rather than a copy of the value, and the
   * distinction is not fussiness — the first version of this table wrote the defaults out by
   * hand and one of them was already wrong. It said `KF_SHIPPED_UNIT_DIR` defaults to
   * `/opt/kf/deploy/systemd`; the default is `deploy/systemd`. `/opt/kf/deploy/systemd` is
   * where the deployment INSTALLS the units, which is what an operator should set — a
   * different fact that happens to be true, sitting in the field for a fact that was not.
   *
   * A table written to stop three copies of a list from drifting is a poor place to start a
   * fourth copy of the defaults.
   */
  readonly defaultKey?: keyof typeof COMMISSIONING_DEFAULTS;
  /**
   * The default, for variables the CLI applies itself and that no check reads — so there is
   * no `COMMISSIONING_DEFAULTS` entry to point at. `KF_ALERT_DISPATCH` is the only one, and
   * `sendTestAlert` reads it from here rather than repeating the path.
   */
  readonly defaultsTo?: string;
}

export const COMMISSIONING_ENVIRONMENT: readonly CommissioningVariable[] = [
  {
    env: 'KF_SYSTEMD_DIR',
    key: 'systemdDirectory',
    kind: 'tunable',
    defaultKey: 'systemdDirectory',
    summary: 'where installed units live — unit_provenance, secret_posture',
  },
  {
    env: 'KF_SHIPPED_UNIT_DIR',
    key: 'shippedUnitDirectory',
    kind: 'tunable',
    defaultKey: 'shippedUnitDirectory',
    summary: "this release's own units, to compare the installed ones against",
  },
  {
    env: 'KF_PUBLIC_HOSTNAME',
    key: 'publicHostname',
    kind: 'required',
    summary: 'the name this host serves, as it appears in the certificate — tls_termination',
  },
  {
    env: 'KF_TLS_CERTIFICATE',
    key: 'tlsCertificatePath',
    kind: 'required',
    summary: 'PEM chain presented for that name — tls_termination',
  },
  {
    env: 'KF_TLS_PRIVATE_KEY',
    key: 'tlsPrivateKeyPath',
    kind: 'required',
    summary: 'its private key; checked for exposure, never read — tls_termination',
  },
  {
    env: 'KF_IDENTITY_ISSUER',
    key: 'identityIssuer',
    kind: 'required',
    summary: 'OIDC issuer, https outside development — identity_provider_policy',
  },
  {
    env: 'KF_IDENTITY_CLIENT_ID',
    key: 'identityClientId',
    kind: 'required',
    summary: 'OIDC client the deployment authenticates as — identity_provider_policy',
  },
  {
    env: 'KF_IDENTITY_POLICY',
    key: 'identityPolicyPath',
    kind: 'required',
    summary: 'the reviewed realm policy on disk — identity_provider_policy',
  },
  {
    env: 'KF_IDENTITY_POLICY_SHA256',
    key: 'identityPolicyDigest',
    kind: 'required',
    summary: 'the digest that policy had when it was reviewed — identity_provider_policy',
  },
  {
    env: 'KF_REVERSE_PROXY_CONFIG',
    key: 'reverseProxyConfigPath',
    kind: 'required',
    summary: 'the nginx configuration AS INSTALLED, not the shipped template',
  },
  {
    env: 'KF_RELEASE_DIR',
    key: 'releaseDirectory',
    kind: 'required',
    summary: 'the release tree, whose own verifier runs — liminal_runtime_inventory',
  },
  {
    env: 'KF_EVIDENCE_DIR',
    key: 'evidenceDirectory',
    kind: 'required',
    summary: 'directory holding commissioning receipts — evidence_receipts',
  },
  {
    env: 'KF_RELEASE_ID',
    key: 'releaseId',
    kind: 'required',
    summary: 'the release this host is supposed to be running — evidence_receipts',
  },
  {
    env: 'KF_EXPECTED_NODE_VERSION',
    key: 'expectedNodeVersion',
    kind: 'required',
    summary: 'the Node version this release was tested against — runtime_version',
  },
  {
    env: 'KF_CERTIFICATE_RENEWAL_DAYS',
    kind: 'tunable',
    defaultKey: 'certificateRenewalDays',
    summary: 'how close to expiry a certificate may be and still satisfy tls_termination',
  },
  {
    env: 'KF_ROLLBACK_REHEARSAL_DAYS',
    kind: 'tunable',
    defaultKey: 'rollbackRehearsalDays',
    summary: 'how old a rollback rehearsal receipt may be and still satisfy evidence_receipts',
  },
  {
    env: 'KF_ALERT_DISPATCH',
    kind: 'tunable',
    defaultsTo: '/opt/kf/scripts/alert-dispatch.sh',
    summary: 'the script --send-test-alert runs; read by no check',
  },
];

/** The variables that carry a string straight through to a check. */
export function stringInputs(): readonly (CommissioningVariable & { key: StringInputKey })[] {
  return COMMISSIONING_ENVIRONMENT.filter(
    (variable): variable is CommissioningVariable & { key: StringInputKey } =>
      variable.key !== undefined,
  );
}

/**
 * What a variable falls back to, as the code that applies it would.
 *
 * Undefined for the required ones, which have no fallback — that is what makes them required.
 */
export function defaultOf(variable: CommissioningVariable): string | undefined {
  if (variable.defaultKey !== undefined) return String(COMMISSIONING_DEFAULTS[variable.defaultKey]);
  return variable.defaultsTo;
}

/** The alert script `--send-test-alert` runs when nobody names one. */
export function alertDispatchDefault(): string {
  const declared = COMMISSIONING_ENVIRONMENT.find((v) => v.env === 'KF_ALERT_DISPATCH');
  const value = declared === undefined ? undefined : defaultOf(declared);
  if (value === undefined) {
    // Fail loudly rather than reaching for a path nobody declared. A commissioning tool that
    // silently invents where the alert script lives is the sort of thing this file exists to
    // prevent.
    throw new Error('KF_ALERT_DISPATCH has no declared default in COMMISSIONING_ENVIRONMENT');
  }
  return value;
}

/**
 * Usage text, generated from the table above so it cannot describe a different program.
 *
 * A hand-written usage block is one more copy of this list, and the reason this file exists is
 * that copies of this list drift.
 */
export function usage(): string {
  const width = Math.max(...COMMISSIONING_ENVIRONMENT.map((v) => v.env.length));
  const line = (v: CommissioningVariable): string => {
    const fallback = defaultOf(v);
    return `  ${v.env.padEnd(width)}  ${v.summary}${fallback === undefined ? '' : ` [${fallback}]`}`;
  };

  return [
    'kf-commissioning — is this host installed the way the deployment says it must be?',
    '',
    '  kf-commissioning                    show every check',
    '  kf-commissioning --json             the same, as JSON, for an evidence record',
    '  kf-commissioning --send-test-alert  send one real alert, then ask a person if it arrived',
    '  kf-commissioning --help             this text',
    '',
    'Exit status is 0 only when every check is satisfied. A check that could not run reports',
    '`unverifiable` and fails exactly as `unsatisfied` does: "we could not look" is not a pass.',
    '',
    'Configuration is entirely environment, because that is what a systemd unit and an',
    "operator's shell both have. Nothing is inferred — an unsupplied value makes its check",
    'unverifiable and says which value was missing.',
    '',
    'Required — a check cannot run without these:',
    ...COMMISSIONING_ENVIRONMENT.filter((v) => v.kind === 'required').map(line),
    '',
    'Optional — these have defaults, and the defaults decide verdicts:',
    ...COMMISSIONING_ENVIRONMENT.filter((v) => v.kind === 'tunable').map(line),
    '',
    'docs/deployment/private-host.md is the deployment contract these serve.',
  ].join('\n');
}
