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
export const identityProviderPolicy: CommissioningCheckFn = async (inputs: CommissioningInputs) => {
  const { identityIssuer, identityClientId, identityPolicyPath, identityPolicyDigest } = inputs;
  if (identityIssuer === undefined || identityClientId === undefined) {
    return {
      status: 'unverifiable',
      detail:
        'No identity issuer and client are configured, so the deployment authenticates nobody.',
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

/**
 * The installed reverse proxy terminates TLS, and nothing behind it is reachable in clear.
 *
 * The API sets `KF_TLS_TERMINATED_UPSTREAM=1` and refuses to start without it, which is an
 * assertion by whoever deployed rather than a fact anyone checked. The threat model says so
 * under T8 — "nothing here can verify that the thing in front of it actually terminates TLS,
 * and a false assertion produces exactly the exposure it claims to prevent".
 *
 * This does not close that gap; the running nginx cannot be interrogated from here and a
 * configuration file is not proof of what is loaded. It narrows it to the part that CAN be
 * read, which is the configuration the host was given. Two properties matter more than the
 * rest:
 *
 *   1. NO CLEARTEXT SERVER MAY PROXY. A `server` listening on 80 without `ssl` must `return`
 *      — a redirect or a refusal. If one proxies to the application instead, every bearer
 *      token it forwards crosses the network in clear, which is the precise exposure the
 *      upstream-termination assertion exists to deny.
 *   2. EVERY UPSTREAM MUST BE LOOPBACK. The API and web processes bind 127.0.0.1 and rely on
 *      the proxy being the only route to them. `proxy_pass` to any other address means
 *      something else on the network can reach a process whose whole threat model assumes it
 *      cannot.
 *
 * Parsing is by brace depth, which is enough for the shipped template's shape and is stated
 * here as a limit rather than implied to be an nginx parser: `include` directives are NOT
 * followed, so a deployment that splits its configuration across files must point this at the
 * file that actually contains the server blocks.
 */
export const reverseProxyPosture: CommissioningCheckFn = async (inputs: CommissioningInputs) => {
  const path = inputs.reverseProxyConfigPath;
  if (path === undefined) {
    return {
      status: 'unverifiable',
      detail:
        'No reverse-proxy configuration was supplied, so KF_TLS_TERMINATED_UPSTREAM=1 remains ' +
        'an unchecked assertion about what sits in front of this deployment.',
      observed: { reverseProxyConfigPath: null },
    };
  }

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    return {
      status: 'unverifiable',
      detail: `Cannot read the reverse-proxy configuration at ${path}: ${message(error)}`,
      observed: { reverseProxyConfigPath: path },
    };
  }

  // `server { ... }` blocks at depth 1. Comments are stripped first so a commented-out
  // `proxy_pass` is not read as a live one.
  const blocks: string[] = [];
  const stripped = text
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
  const serverStarts = [...stripped.matchAll(/\bserver\s*\{/g)];
  for (const start of serverStarts) {
    let depth = 0;
    let index = start.index! + start[0].length - 1;
    const from = index;
    for (; index < stripped.length; index += 1) {
      if (stripped[index] === '{') depth += 1;
      else if (stripped[index] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(stripped.slice(from, index + 1));
  }
  if (blocks.length === 0) {
    return {
      status: 'unverifiable',
      detail: `${path} contains no server blocks. If the configuration uses include directives, point KF_REVERSE_PROXY_CONFIG at the file that defines them — this reader does not follow includes.`,
      observed: { reverseProxyConfigPath: path, serverBlocks: 0 },
    };
  }

  const cleartextProxying: string[] = [];
  const remoteUpstreams: string[] = [];
  const missingForwardedProto: string[] = [];
  const weakProtocols: string[] = [];

  for (const [ordinal, block] of blocks.entries()) {
    const names = /server_name\s+([^;]+);/.exec(block)?.[1]?.trim() ?? `block ${ordinal + 1}`;
    const listens = [...block.matchAll(/\blisten\s+([^;]+);/g)].map((m) => m[1]!.trim());
    const proxied = [...block.matchAll(/\bproxy_pass\s+([^;]+);/g)].map((m) => m[1]!.trim());
    const servesCleartext = listens.some(
      (listen) => !/\bssl\b/.test(listen) && /(^|[^0-9])80(\s|$)/.test(listen),
    );

    if (servesCleartext && proxied.length > 0) cleartextProxying.push(names);

    for (const target of proxied) {
      const host = /^https?:\/\/([^/:]+|\[[^\]]+\])/.exec(target)?.[1] ?? target;
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
        remoteUpstreams.push(`${names} -> ${target}`);
      }
    }
    if (proxied.length > 0 && !/X-Forwarded-Proto\s+https/.test(block)) {
      missingForwardedProto.push(names);
    }
    const protocols = /ssl_protocols\s+([^;]+);/.exec(block)?.[1] ?? '';
    if (/TLSv1(\.1)?(\s|$)/.test(protocols)) weakProtocols.push(`${names}: ${protocols.trim()}`);
  }

  const observed = {
    reverseProxyConfigPath: path,
    serverBlocks: blocks.length,
    cleartextProxying: cleartextProxying.join(', ') || 'none',
    remoteUpstreams: remoteUpstreams.join('; ') || 'none',
    missingForwardedProto: missingForwardedProto.join(', ') || 'none',
    weakProtocols: weakProtocols.join('; ') || 'none',
  };

  if (cleartextProxying.length > 0) {
    return {
      status: 'unsatisfied',
      detail:
        `${cleartextProxying.length} server block(s) accept cleartext HTTP and proxy to the ` +
        'application. Every bearer token they forward crosses the network unencrypted, which ' +
        'is exactly what KF_TLS_TERMINATED_UPSTREAM=1 asserts does not happen.',
      observed,
    };
  }
  if (remoteUpstreams.length > 0) {
    return {
      status: 'unsatisfied',
      detail:
        'A proxy_pass names an upstream that is not loopback. The API and web processes bind ' +
        '127.0.0.1 and rely on this proxy being the only route to them.',
      observed,
    };
  }
  if (weakProtocols.length > 0) {
    return {
      status: 'unsatisfied',
      detail: 'A server block permits TLS 1.0 or 1.1.',
      observed,
    };
  }
  if (missingForwardedProto.length > 0) {
    return {
      status: 'unsatisfied',
      detail:
        'A proxying block does not set X-Forwarded-Proto https, which the application trusts ' +
        'to know whether the original request was encrypted.',
      observed,
    };
  }
  return {
    status: 'satisfied',
    detail:
      `All ${blocks.length} server blocks terminate TLS before proxying, every upstream is ` +
      'loopback, TLS 1.0/1.1 are refused, and each proxying block forwards the original scheme.',
    observed,
  };
};
