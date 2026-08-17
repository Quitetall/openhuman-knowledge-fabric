/**
 * Commissioning: whether a HOST was set up the way the deployment says it must be.
 *
 * Deliberately not readiness. `assessReadiness` answers "is this service working right now"
 * and runs constantly; this answers "was this installation ever done properly" and runs at
 * install, at upgrade, and whenever somebody needs to say so in writing. A service can be
 * perfectly healthy on a host that was never commissioned, which is exactly the confusion
 * `docs/deployment/private-host.md` warns against when it says the document "must not be
 * cited as proof that the Knowledge Fabric is an institutionally authoritative service".
 *
 * Three states, and the third is the important one:
 *
 *   satisfied     the check looked at real host state and it was as required
 *   unsatisfied   the check looked at real host state and it was not
 *   unverifiable  the check could not see the state it needs — a path that does not exist,
 *                 a tool that is not installed, a configuration value nobody supplied
 *
 * `unverifiable` is NOT a pass. It fails commissioning exactly as `unsatisfied` does, and it
 * exists as a separate word only so that "we looked and it was wrong" is never confused with
 * "we could not look". A verifier that reported an absent certificate as compliant would be
 * worse than no verifier, because somebody would cite it.
 */

export type CommissioningStatus = 'satisfied' | 'unsatisfied' | 'unverifiable';

export interface CommissioningCheck {
  readonly id: string;
  readonly status: CommissioningStatus;
  /** What the state of this check means for the deployment, in a sentence an operator can act on. */
  readonly detail: string;
  /** The blocker in `docs/deployment/private-host.md` this check exists to close. */
  readonly blocker: string;
  /** What was actually observed. Present even on failure — especially on failure. */
  readonly observed?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CommissioningReport {
  /** True only when every check is `satisfied`. Any other state, including unverifiable, is false. */
  readonly commissioned: boolean;
  readonly checks: readonly CommissioningCheck[];
}

/**
 * Where the host keeps things, and what the deployment expects to find.
 *
 * Every path is injectable rather than hardcoded, because a check that can only run against
 * `/etc/kf` cannot be tested, and an untested verifier is a claim rather than a check.
 */
export interface CommissioningInputs {
  /** Installed systemd unit directory. Default matches `docs/deployment/private-host.md`. */
  readonly systemdDirectory: string;
  /** The unit files this release ships, to compare the installed ones against. */
  readonly shippedUnitDirectory: string;
  /** Public hostname the deployment serves, as it appears in the certificate. */
  readonly publicHostname?: string;
  /** PEM certificate chain presented for `publicHostname`. */
  readonly tlsCertificatePath?: string;
  /** Private key for that certificate. Checked for exposure, never read. */
  readonly tlsPrivateKeyPath?: string;
  /** OIDC issuer the deployment trusts. Must be https outside development. */
  readonly identityIssuer?: string;
  /** OIDC client the deployment authenticates as. */
  readonly identityClientId?: string;
  /** Reviewed identity-provider policy document, whose digest is recorded below. */
  readonly identityPolicyPath?: string;
  /** SHA-256 the reviewed identity policy is expected to have. */
  readonly identityPolicyDigest?: string;
  /** Directory holding commissioning evidence receipts (release, rollback, qualification). */
  readonly evidenceDirectory?: string;
  /** Release identifier the host is supposed to be running. */
  readonly releaseId?: string;
  /** Node version this release was tested against, e.g. `24.18.1`. */
  readonly expectedNodeVersion?: string;
  /**
   * The reverse-proxy configuration AS INSTALLED, not the template this repository ships.
   *
   * `KF_TLS_TERMINATED_UPSTREAM=1` is an assertion by whoever deployed, and the threat model
   * says so plainly under T8: "nothing here can verify that the thing in front of it actually
   * terminates TLS". This narrows that gap rather than closing it — the installed
   * configuration is a file on the host and can be read, even though the running nginx cannot
   * be interrogated from here.
   */
  readonly reverseProxyConfigPath?: string;
  /**
   * The release tree installed on this host, e.g. `/opt/kf`.
   *
   * Used to run the release's own `verify-liminal-runtime.sh` against itself, which is where
   * the compiler, its `Cargo.lock` and the external runtime closure are digested.
   */
  readonly releaseDirectory?: string;
  /** Days before certificate expiry at which renewal is already overdue. */
  readonly certificateRenewalDays: number;
  /** Days after which a rollback rehearsal no longer counts as evidence. */
  readonly rollbackRehearsalDays: number;
}

export const COMMISSIONING_DEFAULTS = {
  systemdDirectory: '/etc/systemd/system',
  shippedUnitDirectory: 'deploy/systemd',
  certificateRenewalDays: 21,
  rollbackRehearsalDays: 180,
} as const satisfies Partial<CommissioningInputs>;

export type CommissioningCheckFn = (
  inputs: CommissioningInputs,
) => Promise<Omit<CommissioningCheck, 'id' | 'blocker'>>;

export interface CommissioningCheckDefinition {
  readonly id: string;
  readonly blocker: string;
  readonly run: CommissioningCheckFn;
}
