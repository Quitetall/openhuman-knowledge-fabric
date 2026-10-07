import { spawn } from 'node:child_process';
import type { CommissioningCheckFn, CommissioningInputs } from './contracts.js';

/**
 * Nothing listens where the public can reach it, except the private network's own transport.
 *
 * ADR 0039: people reach the first host over a Tailscale tailnet, and nothing is published. The
 * firewall is meant to admit nothing from the public interface but the tailnet's WireGuard
 * transport, but a firewall is one layer and a rule can be lost. This checks the other layer, on
 * the host itself: every socket in LISTEN (TCP) or bound (UDP) is on a loopback address, on one
 * of the host's private addresses (`KF_PRIVATE_LISTEN_ADDRESSES`, the tailnet addresses
 * `tailscale ip` prints), bound to the private interface, or a protocol and port the deployment
 * names as allowed on every address (`KF_PUBLIC_LISTEN_ALLOWED`, by default tailscaled's
 * `udp:41641`). Anything else is reachable from wherever the public address is, firewall
 * permitting, and is named.
 *
 * What it reads is `ss -H -t -u -l -n`, which needs no privilege for the addresses and ports.
 * What it does not prove: what the firewall admits (that is the port scan from outside that
 * ADR 0039's "how we will know" names), or what a process will bind after this ran.
 */

export interface ListeningSocket {
  readonly protocol: 'tcp' | 'udp';
  readonly address: string;
  /** The device a socket is bound to (`0.0.0.0%eth0:68`), or null. */
  readonly device: string | null;
  readonly port: number;
  /** As `ss` printed it, for the operator. */
  readonly raw: string;
}

/** Parse `ss -H -t -u -l -n` output. Lines it cannot read are returned, never dropped. */
export function parseSocketList(text: string): {
  sockets: ListeningSocket[];
  unreadable: string[];
} {
  const sockets: ListeningSocket[] = [];
  const unreadable: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.trim().split(/\s+/);
    const netid = fields[0];
    const local = fields[4];
    const match = local === undefined ? null : /^(.*):(\d+|\*)$/.exec(local);
    if ((netid !== 'tcp' && netid !== 'udp') || match === null || match[2] === '*') {
      unreadable.push(line.trim());
      continue;
    }
    let host = match[1]!;
    let device: string | null = null;
    const percent = host.lastIndexOf('%');
    if (percent !== -1) {
      device = host.slice(percent + 1).replace(/\]$/, '');
      host = host.slice(0, percent) + (host.endsWith(']') ? ']' : '');
    }
    host = host.replace(/^\[|\]$/g, '');
    sockets.push({
      protocol: netid,
      address: host === '*' ? '0.0.0.0' : host.toLowerCase(),
      device,
      port: Number(match[2]),
      raw: local!,
    });
  }
  return { sockets, unreadable };
}

function isLoopback(address: string): boolean {
  return /^127\./.test(address) || address === '::1' || /^::ffff:127\./.test(address);
}

export interface ExposurePolicy {
  /** The private addresses people reach the host through. */
  readonly privateAddresses: readonly string[];
  /** The interface those addresses live on; a socket bound to it is private whatever its address. */
  readonly privateInterface: string;
  /** `proto:port` entries allowed on every address. */
  readonly allowed: readonly string[];
}

/** The sockets that are reachable from somewhere other than loopback or the private network. */
export function exposedSockets(
  sockets: readonly ListeningSocket[],
  policy: ExposurePolicy,
): ListeningSocket[] {
  const privateAddresses = new Set(policy.privateAddresses.map((a) => a.toLowerCase()));
  const allowed = new Set(policy.allowed.map((a) => a.toLowerCase()));
  return sockets.filter((socket) => {
    if (isLoopback(socket.address)) return false;
    if (privateAddresses.has(socket.address)) return false;
    if (
      socket.device !== null &&
      (socket.device === 'lo' || socket.device === policy.privateInterface)
    ) {
      return false;
    }
    return !allowed.has(`${socket.protocol}:${String(socket.port)}`);
  });
}

function listSockets(ssPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ssPath, ['-H', '-t', '-u', '-l', '-n'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${ssPath} exited ${String(code)}: ${err.trim().slice(0, 200)}`));
    });
  });
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

export const publicExposure: CommissioningCheckFn = async (inputs: CommissioningInputs) => {
  const privateAddresses = list(inputs.privateListenAddresses);
  if (privateAddresses.length === 0) {
    return {
      status: 'unverifiable',
      detail:
        'No private listen addresses were supplied (KF_PRIVATE_LISTEN_ADDRESSES: on a tailnet ' +
        'host, what `tailscale ip` prints), so nothing here can tell a private listener from a ' +
        'public one.',
      observed: { privateListenAddresses: null },
    };
  }
  const allowed = list(inputs.publicListenAllowed);
  const malformed = allowed.filter((entry) => !/^(tcp|udp):\d{1,5}$/i.test(entry));
  if (malformed.length > 0) {
    return {
      status: 'unverifiable',
      detail: `KF_PUBLIC_LISTEN_ALLOWED entries must be tcp:<port> or udp:<port>; got ${malformed.join(', ')}.`,
      observed: { publicListenAllowed: inputs.publicListenAllowed },
    };
  }
  let text: string;
  try {
    text = await listSockets(inputs.socketStatisticsPath);
  } catch (error: unknown) {
    return {
      status: 'unverifiable',
      detail: `Cannot list listening sockets with ${inputs.socketStatisticsPath}: ${error instanceof Error ? error.message : String(error)}`,
      observed: { socketStatisticsPath: inputs.socketStatisticsPath },
    };
  }
  const { sockets, unreadable } = parseSocketList(text);
  const exposed = exposedSockets(sockets, {
    privateAddresses,
    privateInterface: inputs.privateInterface,
    allowed,
  });
  const observed = {
    privateListenAddresses: privateAddresses.join(', '),
    privateInterface: inputs.privateInterface,
    publicListenAllowed: allowed.join(', ') || 'none',
    listening: sockets.length,
    exposed: exposed.map((s) => `${s.protocol} ${s.raw}`).join('; ') || 'none',
    unreadable: unreadable.join('; ') || 'none',
  };
  if (exposed.length > 0) {
    return {
      status: 'unsatisfied',
      detail:
        `${String(exposed.length)} socket(s) listen on an address other than loopback or the ` +
        `private network: ${observed.exposed}. Bind each to loopback or a private address, or ` +
        'name it in KF_PUBLIC_LISTEN_ALLOWED if it is meant to face the public interface.',
      observed,
    };
  }
  if (unreadable.length > 0) {
    return {
      status: 'unverifiable',
      detail: `${String(unreadable.length)} socket line(s) could not be read, and a socket that cannot be read cannot be cleared.`,
      observed,
    };
  }
  return {
    status: 'satisfied',
    detail:
      `All ${String(sockets.length)} listening sockets are on loopback, on ${privateAddresses.join(', ')}, ` +
      `on ${inputs.privateInterface}, or an allowed transport (${observed.publicListenAllowed}).`,
    observed,
  };
};
