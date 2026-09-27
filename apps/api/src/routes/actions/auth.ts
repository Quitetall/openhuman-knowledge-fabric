import {
  AttestorUnavailable,
  IdentityRejected,
  LocalAttestor,
  TokenVerifier,
  holdingsFrom,
  soleAssignment,
  type Attestor,
} from '@kf/authorization';
import { withTransaction, type Pool } from '@kf/database';
import type { FastifyReply } from 'fastify';
import type { Caller, IdentifyCaller, ListHoldings } from './contracts.js';

export class CallerRejected extends Error {}

const HEADER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      const named = request.headers['x-kf-acting-role'];
      if (request.deriveAssignment === true && (typeof named !== 'string' || named.trim() === '')) {
        // The development header path, deriving as the attestor does. The lookup is callable
        // only by a login that may attest (20260925090000), which is exactly the development
        // login this path runs on; anywhere else it is refused at the database.
        const actor = request.headers['x-kf-actor'];
        const organization = request.headers['x-kf-organization'];
        if (
          typeof actor !== 'string' ||
          typeof organization !== 'string' ||
          !HEADER_UUID.test(actor) ||
          !HEADER_UUID.test(organization)
        ) {
          throw new CallerRejected(
            'x-kf-actor and x-kf-organization must name a person and an organization',
          );
        }
        const rows = await withTransaction(pool, (tx) =>
          tx.query<{ assignment_id: string; role_id: string; scope_id: string }>(
            'select assignment_id, role_id, scope_id from org.live_assignments_of($1, $2)',
            [actor, organization],
          ),
        );
        const derived = soleAssignment(
          rows.map((row) => ({
            assignmentId: row.assignment_id,
            roleId: row.role_id,
            scopeId: row.scope_id,
          })),
        );
        return callerFrom({ ...request.headers, 'x-kf-acting-role': derived });
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
      ...(request.deriveAssignment === true ? { deriveAssignment: true } : {}),
      ...(request.surface === undefined ? {} : { surface: request.surface }),
    });
  };
}

/**
 * The one way a route learns everything the caller's own person holds (20260926120000).
 *
 * The same two paths as `createCallerIdentifier`, decided the same way. With an identity provider,
 * the bearer token goes to the attestor, which verifies it and lists the assignments of the
 * person it is linked to; nothing else in the request reaches the lookup. Without one, only the
 * development profile's header path, over the lookup only a login that may attest can call.
 */
export function createHoldingsLister(
  pool: Pool,
  tokens: Attestor | TokenVerifier | undefined,
  options: CallerIdentifierOptions,
): ListHoldings {
  const attestor = tokens instanceof TokenVerifier ? new LocalAttestor(pool, tokens) : tokens;
  return async ({ headers }) => {
    if (attestor === undefined) {
      if (!options.trustHeaders) {
        throw new CallerRejected(
          'no identity provider is configured and header identity is not trusted',
        );
      }
      const actor = headers['x-kf-actor'];
      if (typeof actor !== 'string' || !HEADER_UUID.test(actor)) {
        throw new CallerRejected('x-kf-actor must name a person');
      }
      const rows = await withTransaction(pool, (tx) =>
        tx.query<{
          organization_id: string;
          legal_name: string;
          assignment_id: string;
          role_id: string;
          scope_id: string;
        }>(
          `select organization_id, legal_name, assignment_id, role_id, scope_id
             from org.live_assignments_everywhere_of($1)`,
          [actor],
        ),
      );
      return holdingsFrom(
        actor,
        rows.map((row) => ({
          organizationId: row.organization_id,
          legalName: row.legal_name,
          assignmentId: row.assignment_id,
          roleId: row.role_id,
          scopeId: row.scope_id,
        })),
      );
    }
    const authorization = headers['authorization'];
    const token =
      typeof authorization === 'string' && /^bearer /i.test(authorization)
        ? authorization.slice(7).trim()
        : '';
    return attestor.holdings(token);
  };
}
