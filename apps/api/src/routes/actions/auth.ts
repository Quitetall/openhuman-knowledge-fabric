import { IdentityRejected, resolveCaller, type TokenVerifier } from '@kf/authorization';
import type { Pool } from '@kf/database';
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
    // Defaults to the LOWEST tier, never the highest. A caller who does not state a
    // clearance gets the least, so a missing header narrows what is visible rather than
    // widening it.
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
 */
export function unidentified(err: unknown): { error: string; message: string } {
  if (err instanceof IdentityRejected) {
    return { error: err.failure, message: err.message };
  }
  return { error: 'caller_unidentified', message: (err as Error).message };
}

export function createCallerIdentifier(
  pool: Pool,
  verifier: TokenVerifier | undefined,
): IdentifyCaller {
  return async (request): Promise<Caller> => {
    if (verifier === undefined) return callerFrom(request.headers);

    const authorization = request.headers['authorization'];
    const token =
      typeof authorization === 'string' && /^bearer /i.test(authorization)
        ? authorization.slice(7).trim()
        : '';

    const header = (name: string): string => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : '';
    };
    return resolveCaller(pool, verifier, {
      token,
      actingRoleId: header('x-kf-acting-role'),
      organizationId: header('x-kf-organization'),
      maxClassification: header('x-kf-classification') || 'internal',
    });
  };
}
