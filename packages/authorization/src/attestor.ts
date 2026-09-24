/**
 * The attestor seam: how the API turns a bearer token into an attested caller.
 *
 * The database binds a person for the application login only on an attestation that they are
 * present (20260924001000), and the application login cannot issue one. Issuing belongs to
 * kf-attestor, a separate process with its own Unix user and its own database login, which the
 * API reaches over a Unix socket. A compromised API can therefore still act for a person who is
 * sending it requests — it sees their tokens — but no longer for anybody it merely names.
 *
 * Both implementations run the SAME code, `resolveCaller`: token verification is not forked.
 *
 *   SocketAttestor  the API's side of the socket; production.
 *   LocalAttestor   `resolveCaller` in-process over a pool that may attest. kf-attestor itself
 *                   uses it behind the socket, and the development profile uses it directly.
 *
 * The wire is HTTP/1.1 over the socket, one JSON request and one JSON answer, so an operator can
 * probe it with `curl --unix-socket`. Nothing on it is a secret the API does not already hold:
 * the token came from the API, and the attestation goes back to it.
 */

import { request as httpRequest } from 'node:http';
import type { Pool } from '@kf/database';
import {
  IdentityRejected,
  resolveCaller,
  type Caller,
  type CallerRequest,
  type IdentityFailure,
  type TokenVerifier,
} from './identity.js';

export interface Attestor {
  /** Verify the token, resolve the person, and return the caller with its attestation. */
  identify(request: CallerRequest): Promise<Caller>;
}

export class LocalAttestor implements Attestor {
  readonly #pool: Pool;
  readonly #verifier: TokenVerifier;

  constructor(pool: Pool, verifier: TokenVerifier) {
    this.#pool = pool;
    this.#verifier = verifier;
  }

  identify(request: CallerRequest): Promise<Caller> {
    return resolveCaller(this.#pool, this.#verifier, request);
  }
}

/** The one path kf-attestor serves. */
export const ATTESTOR_PATH = '/attest';
/** Bodies larger than this are refused unread: a bearer token and three ids fit many times over. */
export const ATTESTOR_MAX_BODY_BYTES = 16 * 1024;

const IDENTITY_FAILURES: ReadonlySet<IdentityFailure> = new Set<IdentityFailure>([
  'no_token',
  'invalid_token',
  'unknown_subject',
  'revoked_identity',
  'role_not_held',
  'classification_not_granted',
  'no_role_requested',
]);

/** Read a request body as the attestor accepts it, or undefined for anything else. */
export function parseAttestorRequest(body: unknown): CallerRequest | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined;
  const token = text('token');
  const actingRoleId = text('actingRoleId');
  const organizationId = text('organizationId');
  const maxClassification = text('maxClassification');
  if (
    token === undefined ||
    actingRoleId === undefined ||
    organizationId === undefined ||
    maxClassification === undefined
  ) {
    return undefined;
  }
  return { token, actingRoleId, organizationId, maxClassification };
}

/** A caller as it crosses the socket: dates as ISO strings, absent values as null. */
export function encodeAttestedCaller(caller: Caller): Record<string, unknown> {
  return {
    actorId: caller.actorId,
    actingRoleId: caller.actingRoleId,
    organizationId: caller.organizationId,
    maxClassification: caller.maxClassification,
    subject: caller.subject,
    attestation: caller.attestation ?? null,
    authentication: {
      authenticatedAt: caller.authentication.authenticatedAt?.toISOString() ?? null,
      assuranceLevel: caller.authentication.assuranceLevel ?? null,
      methods: [...caller.authentication.methods],
    },
  };
}

function decodeAttestedCaller(body: unknown): Caller {
  const refuse = (): never => {
    throw new Error('the attestor answered with a body that is not an attested caller');
  };
  if (typeof body !== 'object' || body === null) return refuse();
  const record = body as Record<string, unknown>;
  const text = (key: string): string =>
    typeof record[key] === 'string' && record[key] !== '' ? (record[key] as string) : refuse();
  const auth = record['authentication'];
  if (typeof auth !== 'object' || auth === null) return refuse();
  const a = auth as Record<string, unknown>;
  const at = a['authenticatedAt'];
  const level = a['assuranceLevel'];
  const methods = a['methods'];
  if (!Array.isArray(methods) || !methods.every((m) => typeof m === 'string')) return refuse();
  const attestation = text('attestation');
  if (!/^[0-9a-f]{64}$/.test(attestation)) return refuse();
  return {
    actorId: text('actorId'),
    actingRoleId: text('actingRoleId'),
    organizationId: text('organizationId'),
    maxClassification: text('maxClassification'),
    subject: text('subject'),
    attestation,
    authentication: {
      authenticatedAt: typeof at === 'string' ? new Date(at) : undefined,
      assuranceLevel: typeof level === 'string' ? level : undefined,
      methods: methods as string[],
    },
  };
}

/** The status and body kf-attestor answers a refusal with. */
export function encodeRefusal(err: IdentityRejected): {
  status: number;
  body: Record<string, unknown>;
} {
  return { status: 401, body: { failure: err.failure, message: err.message } };
}

/**
 * kf-attestor could not be asked: its socket is absent or refuses the connection, it did not
 * answer in time, or it answered that it could not attest (5xx). Nothing is known about the
 * caller, so this is neither a refusal of them (401) nor a defect in the API (500): the API
 * answers 503 `attestor_unavailable` and binds nobody. There is no local fallback — a fallback
 * would be the API attesting to people itself, which is the separation this exists to keep.
 */
export class AttestorUnavailable extends Error {
  /** The socket that was dialled, for the operator's log. Never sent to a caller. */
  readonly socketPath: string;
  /** What went wrong, as a short code: ENOENT, ECONNREFUSED, EACCES, timeout, status 500, ... */
  readonly reason: string;

  constructor(socketPath: string, reason: string, options?: ErrorOptions) {
    super(`kf-attestor at ${socketPath} is unavailable (${reason})`, options);
    this.name = 'AttestorUnavailable';
    this.socketPath = socketPath;
    this.reason = reason;
  }
}

/** Whether kf-attestor answered the last time it was asked, and if not, why. */
export type AttestorAvailability =
  | { readonly available: true; readonly socketPath: string }
  | { readonly available: false; readonly socketPath: string; readonly reason: string };

export interface SocketAttestorOptions {
  /** Give up on an answer after this long. The API answers the request 503 meanwhile. */
  readonly timeoutMillis?: number;
  /**
   * Told when the attestor goes from answering to not answering, and back. Transitions only, so
   * an outage is logged once with the socket path rather than once per request.
   */
  readonly onAvailabilityChange?: (state: AttestorAvailability) => void;
}

/** Connection-level failures: nothing on the other end of the socket took the request. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'ECONNREFUSED',
  'EACCES',
  'ENOTSOCK',
  'ECONNRESET',
  'EPIPE',
]);

class AttestorTimedOut extends Error {}

/** The API's side of the socket. */
export class SocketAttestor implements Attestor {
  readonly #socketPath: string;
  readonly #timeoutMillis: number;
  readonly #onAvailabilityChange: ((state: AttestorAvailability) => void) | undefined;
  /** Undefined until the first exchange, so the first failure is reported too. */
  #available: boolean | undefined;

  constructor(socketPath: string, options: SocketAttestorOptions = {}) {
    this.#socketPath = socketPath;
    this.#timeoutMillis = options.timeoutMillis ?? 5_000;
    this.#onAvailabilityChange = options.onAvailabilityChange;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async identify(request: CallerRequest): Promise<Caller> {
    // The same pre-checks resolveCaller makes, so an empty header costs no round trip and gets
    // the same answer it always did.
    if (request.token.trim() === '') {
      throw new IdentityRejected('no_token', 'no bearer token was supplied');
    }
    if (request.actingRoleId.trim() === '') {
      throw new IdentityRejected(
        'no_role_requested',
        'the acting role must be stated; holding a role is not the same as acting under it',
      );
    }
    const { status, body } = await this.#reach('POST', ATTESTOR_PATH, request);
    if (status === 200) return decodeAttestedCaller(body);
    if (status === 401 && typeof body === 'object' && body !== null) {
      const failure = (body as Record<string, unknown>)['failure'];
      const message = (body as Record<string, unknown>)['message'];
      if (typeof failure === 'string' && IDENTITY_FAILURES.has(failure as IdentityFailure)) {
        throw new IdentityRejected(
          failure as IdentityFailure,
          typeof message === 'string' ? message : 'identity rejected',
        );
      }
    }
    throw new Error(`the attestor answered ${status}`);
  }

  /** Whether the attestor is up and answering on its socket. For readiness only. */
  async healthy(): Promise<boolean> {
    try {
      return (await this.#reach('GET', '/health', undefined)).status === 200;
    } catch {
      return false;
    }
  }

  /**
   * One exchange, with every way of not reaching the attestor turned into AttestorUnavailable
   * and the availability transition reported. A body that is not JSON, or not an attested
   * caller, stays a plain Error: that is an attestor that answered wrongly, not one that is down.
   */
  async #reach(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
  ): Promise<{ status: number; body: unknown }> {
    let answer: { status: number; body: unknown };
    try {
      answer = await this.#exchange(method, path, payload);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (err instanceof AttestorTimedOut) throw this.#down('timeout', err);
      if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) throw this.#down(code, err);
      throw err;
    }
    // The attestor's own refusal to attest for a reason of its own (its database is down).
    if (answer.status >= 500) throw this.#down(`status ${answer.status}`);
    this.#transition(true, undefined);
    return answer;
  }

  #down(reason: string, cause?: unknown): AttestorUnavailable {
    this.#transition(false, reason);
    return new AttestorUnavailable(
      this.#socketPath,
      reason,
      cause === undefined ? undefined : { cause },
    );
  }

  #transition(available: boolean, reason: string | undefined): void {
    if (this.#available === available) return;
    // A first success is not news; a first failure is.
    const report = this.#available !== undefined || !available;
    this.#available = available;
    if (!report || this.#onAvailabilityChange === undefined) return;
    this.#onAvailabilityChange(
      available
        ? { available: true, socketPath: this.#socketPath }
        : { available: false, socketPath: this.#socketPath, reason: reason ?? 'unknown' },
    );
  }

  #exchange(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8');
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: this.#socketPath,
          path,
          method,
          headers: {
            'content-type': 'application/json',
            ...(data === undefined ? {} : { 'content-length': String(data.length) }),
          },
          timeout: this.#timeoutMillis,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > ATTESTOR_MAX_BODY_BYTES) {
              req.destroy(new Error('the attestor answer is too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            try {
              body = text === '' ? undefined : JSON.parse(text);
            } catch {
              reject(new Error('the attestor answered with a body that is not JSON'));
              return;
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () =>
        req.destroy(new AttestorTimedOut('the attestor did not answer in time')),
      );
      req.on('error', reject);
      req.end(data);
    });
  }
}
