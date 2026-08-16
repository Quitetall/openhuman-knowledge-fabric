import { createHash, X509Certificate } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommissioningCheckFn, CommissioningInputs } from './contracts.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The certificate the host presents is for this host, is currently valid, and its key is closed.
 *
 * `KF_TLS_TERMINATED_UPSTREAM=1` in the API unit says the process speaks plain HTTP to a proxy
 * and that TLS is somebody else's job. This is the check that somebody actually did it — the
 * setting is a statement about the deployment, and until this passes it is an unverified one.
 */
export const tlsTermination: CommissioningCheckFn = async (inputs: CommissioningInputs) => {
  const { publicHostname, tlsCertificatePath, tlsPrivateKeyPath } = inputs;
  if (
    publicHostname === undefined ||
    tlsCertificatePath === undefined ||
    tlsPrivateKeyPath === undefined
  ) {
    return {
      status: 'unverifiable',
      detail:
        'No public hostname, certificate and private key were supplied, so nothing here can ' +
        'say the deployment terminates TLS for the name it serves.',
      observed: {
        publicHostname: publicHostname ?? null,
        certificate: tlsCertificatePath ?? null,
        privateKey: tlsPrivateKeyPath ?? null,
      },
    };
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(await readFile(tlsCertificatePath));
  } catch (error: unknown) {
    return {
      status: 'unverifiable',
      detail: `Cannot read a certificate from ${tlsCertificatePath}: ${message(error)}`,
      observed: { certificate: tlsCertificatePath },
    };
  }

  let keyExposed: string | null = null;
  try {
    const key = await stat(tlsPrivateKeyPath);
    if ((key.mode & 0o077) !== 0) {
      keyExposed = (key.mode & 0o777).toString(8).padStart(3, '0');
    }
  } catch (error: unknown) {
    return {
      status: 'unverifiable',
      detail: `Cannot inspect the private key at ${tlsPrivateKeyPath}: ${message(error)}`,
      observed: { privateKey: tlsPrivateKeyPath },
    };
  }

  // `checkHost` applies the wildcard and SAN rules rather than string-matching a subject, which
  // is the difference between "the certificate mentions this name" and "this certificate is
  // valid for this name".
  const namedHost = certificate.checkHost(publicHostname) !== undefined;
  const validTo = new Date(certificate.validTo);
  const validFrom = new Date(certificate.validFrom);
  const now = new Date();
  const daysRemaining = Math.floor((validTo.getTime() - now.getTime()) / DAY_MS);

  const observed = {
    subject: certificate.subject,
    hostname: publicHostname,
    coversHostname: namedHost,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    daysRemaining,
    privateKeyMode: keyExposed,
  };

  if (!namedHost) {
    return {
      status: 'unsatisfied',
      detail: `The certificate is not valid for ${publicHostname}; a browser reaching this deployment would refuse it.`,
      observed,
    };
  }
  if (validFrom > now || validTo <= now) {
    return {
      status: 'unsatisfied',
      detail: `The certificate is outside its validity window (${observed.validFrom} to ${observed.validTo}).`,
      observed,
    };
  }
  if (keyExposed !== null) {
    return {
      status: 'unsatisfied',
      detail: `The private key is mode ${keyExposed}: readable beyond its owner, which makes the certificate worthless.`,
      observed,
    };
  }
  if (daysRemaining < inputs.certificateRenewalDays) {
    return {
      status: 'unsatisfied',
      detail: `The certificate expires in ${daysRemaining} day(s), inside the ${inputs.certificateRenewalDays}-day renewal window. Renewal is already overdue, not upcoming.`,
      observed,
    };
  }
  return {
    status: 'satisfied',
    detail: `A certificate valid for ${publicHostname} is installed, has ${daysRemaining} day(s) left, and its key is closed to group and other.`,
    observed,
  };
};

/**
 * The identity provider is configured to a reviewed policy, and the policy has not moved.
 *
 * This check cannot tell you the realm behaves correctly in a browser — that is human
 * evidence and stays human. What it CAN tell you is that the deployment points at an https
 * issuer, names a client, and that the reviewed policy document is the one that was reviewed:
 * a policy that drifted after review is not a reviewed policy.
 */
export const identityProviderPolicy: CommissioningCheckFn = async (
  inputs: CommissioningInputs,
) => {
  const { identityIssuer, identityClientId, identityPolicyPath, identityPolicyDigest } = inputs;
  if (identityIssuer === undefined || identityClientId === undefined) {
    return {
      status: 'unverifiable',
      detail: 'No identity issuer and client are configured, so the deployment authenticates nobody.',
      observed: { issuer: identityIssuer ?? null, clientId: identityClientId ?? null },
    };
  }

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(identityIssuer);
  } catch {
    return {
      status: 'unsatisfied',
      detail: `The configured issuer ${identityIssuer} is not a URL.`,
      observed: { issuer: identityIssuer },
    };
  }
  if (issuerUrl.protocol !== 'https:') {
    return {
      status: 'unsatisfied',
      detail: `The issuer is ${issuerUrl.protocol}//; tokens whose issuer is reached over plaintext prove nothing.`,
      observed: { issuer: identityIssuer },
    };
  }

  if (identityPolicyPath === undefined || identityPolicyDigest === undefined) {
    return {
      status: 'unverifiable',
      detail:
        'The issuer and client are configured, but no reviewed realm policy and expected digest ' +
        'were supplied — so nothing states what the provider was reviewed to do.',
      observed: { issuer: identityIssuer, clientId: identityClientId },
    };
  }

  let digest: string;
  try {
    digest = createHash('sha256')
      .update(await readFile(identityPolicyPath))
      .digest('hex');
  } catch (error: unknown) {
    return {
      status: 'unverifiable',
      detail: `Cannot read the reviewed identity policy at ${identityPolicyPath}: ${message(error)}`,
      observed: { policy: identityPolicyPath },
    };
  }

  const observed = {
    issuer: identityIssuer,
    clientId: identityClientId,
    policy: identityPolicyPath,
    expectedDigest: identityPolicyDigest,
    actualDigest: digest,
  };
  if (digest !== identityPolicyDigest) {
    return {
      status: 'unsatisfied',
      detail:
        'The identity-provider policy on disk is not the one that was reviewed. A policy that ' +
        'changed after review is an unreviewed policy, whatever the change was.',
      observed,
    };
  }
  return {
    status: 'satisfied',
    detail: `The deployment trusts ${issuerUrl.origin} as client ${identityClientId} under the exact reviewed policy. Browser behaviour remains human evidence.`,
    observed,
  };
};

/**
 * The host runs the runtime this release was tested against.
 *
 * A minor Node difference is usually nothing and occasionally is the whole incident. The
 * deployment pins a version; this reports whether the process doing the checking is running
 * it, which is the only Node version this program can honestly speak for.
 */
export const runtimeVersion: CommissioningCheckFn = async (inputs: CommissioningInputs) => {
  const expected = inputs.expectedNodeVersion;
  const actual = process.versions.node;
  if (expected === undefined) {
    return {
      status: 'unverifiable',
      detail: `No tested Node version was supplied to compare against; this process is running ${actual}.`,
      observed: { actual },
    };
  }
  if (expected !== actual) {
    return {
      status: 'unsatisfied',
      detail: `This host runs Node ${actual}; the release was tested on ${expected}.`,
      observed: { expected, actual },
    };
  }
  return {
    status: 'satisfied',
    detail: `Node ${actual} matches the version this release was tested on.`,
    observed: { expected, actual },
  };
};

/**
 * The receipts that only a completed operation can produce.
 *
 * A rollback rehearsal, a verified release manifest and a ratified compiler qualification are
 * each the output of somebody having actually done something. They cannot be inferred, only
 * recorded — so the check is that the record exists, names the release the host is running,
 * and in the rehearsal's case is recent enough to still describe this system.
 */
export const evidenceReceipts: CommissioningCheckFn = async (inputs: CommissioningInputs) => {
  const { evidenceDirectory, releaseId } = inputs;
  if (evidenceDirectory === undefined || releaseId === undefined) {
    return {
      status: 'unverifiable',
      detail:
        'No evidence directory and release identifier were supplied, so no receipt can be ' +
        'matched to what this host is running.',
      observed: { evidenceDirectory: evidenceDirectory ?? null, releaseId: releaseId ?? null },
    };
  }

  const required = [
    { file: 'release-verification.json', what: 'release manifest verification' },
    { file: 'rollback-rehearsal.json', what: 'disposable-cluster rollback rehearsal' },
    { file: 'compiler-qualification.json', what: 'ratified Liminal compiler qualification' },
  ] as const;

  const missing: string[] = [];
  const wrongRelease: string[] = [];
  const stale: string[] = [];
  const observed: Record<string, string | number | boolean | null> = { releaseId };

  for (const { file, what } of required) {
    let receipt: { release?: unknown; recordedAt?: unknown; ratified?: unknown };
    try {
      receipt = JSON.parse(await readFile(join(evidenceDirectory, file), 'utf8')) as typeof receipt;
    } catch (error: unknown) {
      missing.push(`${what} (${file}: ${message(error)})`);
      continue;
    }
    if (receipt.release !== releaseId) {
      wrongRelease.push(`${what} names ${String(receipt.release)}, host runs ${releaseId}`);
      continue;
    }
    if (file === 'compiler-qualification.json' && receipt.ratified !== true) {
      stale.push(`${what} is recorded but not ratified`);
      continue;
    }
    if (file === 'rollback-rehearsal.json') {
      const recordedAt = new Date(String(receipt.recordedAt));
      const ageDays = Math.floor((Date.now() - recordedAt.getTime()) / DAY_MS);
      observed['rollbackRehearsalAgeDays'] = Number.isFinite(ageDays) ? ageDays : -1;
      if (!Number.isFinite(ageDays) || ageDays > inputs.rollbackRehearsalDays) {
        stale.push(
          `${what} is ${Number.isFinite(ageDays) ? `${ageDays} days` : 'of unreadable age'}, past the ${inputs.rollbackRehearsalDays}-day limit`,
        );
      }
    }
  }

  observed['missing'] = missing.join('; ') || 'none';
  observed['wrongRelease'] = wrongRelease.join('; ') || 'none';
  observed['stale'] = stale.join('; ') || 'none';

  if (missing.length > 0) {
    return {
      status: 'unverifiable',
      detail: `${missing.length} commissioning receipt(s) do not exist. The operations they record may or may not have happened; nothing here can tell.`,
      observed,
    };
  }
  if (wrongRelease.length > 0 || stale.length > 0) {
    return {
      status: 'unsatisfied',
      detail: `Receipts exist but do not describe this host: ${[...wrongRelease, ...stale].join('; ')}.`,
      observed,
    };
  }
  return {
    status: 'satisfied',
    detail: `Release verification, rollback rehearsal and ratified compiler qualification all exist for ${releaseId}.`,
    observed,
  };
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
