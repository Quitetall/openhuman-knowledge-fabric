import {
  AttestorUnavailable,
  IdentityRejected,
  LocalAttestor,
  TokenVerifier,
  type Attestor,
} from '@kf/authorization';
import type { Pool } from '@kf/database';
import type { FastifyReply } from 'fastify';
import type { Caller, IdentifyCaller } from './contracts.js';

export class CallerRejected extends Error {}

export function callerFrom(headers: Record<string, unknown>): Caller {
  const get = (name: string): string => {
    const value = headers[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new CallerRejected(`${name} is required`);
    }
    return value;
  };
  return {
    // Nothing proved an authentication event here — a header is an assertion, not a login.
    // Stated explicitly so no step-up policy can be satisfied by this path by accident.
    authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    actorId: get('x-kf-actor'),
    actingRoleId: get('x-kf-acting-role'),
    organizationId: get('x-kf-organization'),
    // Defaults to `internal`, the SECOND-lowest of four: `public` is rank 0, `internal` is 1.
    //
    // This comment previously read "Defaults to the LOWEST tier … gets the least", and that
    // was wrong. A caller who states nothing sees everything classified `public` AND
    // `internal`. Corrected rather than quietly reworded, because a comment that overstates a
    // safety property in the auth path is how nobody reads it again.
    //
    // The value is deliberately unchanged here. This header path exists only for the explicit
    // development profile and is visibly non-authoritative. Token-backed requests take the
    // same requested value through `resolveIn`, where the database clearance resolver narrows
    // it before `core.set_access_context` sees it.
    maxClassification:
      typeof headers['x-kf-classification'] === 'string'
        ? (headers['x-kf-classification'] as string)
        : 'internal',
  };
}

/**
 * A 401 body that says which check refused, without saying which would have passed.
 *
 * The failure CODE is returned because a caller needs to know whether to re-authenticate, ask
 * for a role, or give up. The token verifier's own reasons are deliberately collapsed into one
 * — telling an attacker whether the signature or the audience was wrong tells them which part
 * of a forged token to fix next.
 *
 * Only messages this code authored are echoed. Anything else reaching here — a pool timeout, a
 * pg error from the role lookup — carries text about the server (hosts, roles, SQL), and a 401
 * body is read by exactly the people it should not be read by.
 */
export function unidentified(err: unknown): { error: string; message: string } {
  if (err instanceof IdentityRejected) {
    return { error: err.failure, message: err.message };
  }
  if (err instanceof CallerRejected) {
    return { error: 'caller_unidentified', message: err.message };
  }
  return { error: 'caller_unidentified', message: 'The caller could not be identified.' };
}

/**
 * Answer a request whose caller could not be identified.
 *
 * 401 when the caller was refused — no token, a bad one, a role they do not hold. 503
 * `attestor_unavailable` when nobody could be asked: kf-attestor is down, and the caller may be
 * perfectly valid. Telling that person to sign in again would send them round a login loop that
 * cannot succeed, and reporting it as a 500 would page for a defect that is an outage. The socket
 * path and cause go to the log (SocketAttestor reports the outage once, on the transition), never
 * to the caller.
 */
export function refuseUnidentified(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AttestorUnavailable) return attestorUnavailable(reply);
  return reply.code(401).send(unidentified(err));
}

/** The 503 every route answers while kf-attestor cannot be reached. Fail closed: no fallback. */
export function attestorUnavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).header('retry-after', '5').send({
    error: 'attestor_unavailable',
    message: 'Identity cannot be verified right now. Try again shortly.',
  });
}

export interface CallerIdentifierOptions {
  /**
   * Whether x-kf-* headers may name the caller when no verifier is configured. Only the
   * development profile says yes (see app.ts).
   */
  readonly trustHeaders: boolean;
}

/**
 * The one way every route learns who is calling.
 *
 * Header trust is an explicit input, not an inference from "no verifier". This identifier used
 * to fall back to headers whenever the verifier was absent, and it is handed to the document,
 * ML, search and identifier routes as well as /actions — so only /actions honoured
 * `trustHeaders`, and a verifier-less app believed headers everywhere else. With neither a
 * verifier nor header trust there is no way to identify anybody, and every request is refused.
 */
export function createCallerIdentifier(
  pool: Pool,
  tokens: Attestor | TokenVerifier | undefined,
  options: CallerIdentifierOptions,
): IdentifyCaller {
  // A bare verifier means "attest in-process over this pool", which only a pool whose login may
  // attest can do: the development profile's, or a test's. Production hands in the socket.
  const attestor = tokens instanceof TokenVerifier ? new LocalAttestor(pool, tokens) : tokens;
  return async (request): Promise<Caller> => {
    if (attestor === undefined) {
      if (!options.trustHeaders) {
        throw new CallerRejected(
          'no identity provider is configured and header identity is not trusted',
        );
      }
      return callerFrom(request.headers);
    }

    const authorization = request.headers['authorization'];
    const token =
      typeof authorization === 'string' && /^bearer /i.test(authorization)
        ? authorization.slice(7).trim()
        : '';

    const header = (name: string): string => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : '';
    };
    // The attestor verifies the token and returns the caller with the database's attestation
    // that they are present, which every bind in this request then carries.
    return attestor.identify({
      token,
      actingRoleId: header('x-kf-acting-role'),
      organizationId: header('x-kf-organization'),
      maxClassification: header('x-kf-classification') || 'internal',
    });
  };
}
