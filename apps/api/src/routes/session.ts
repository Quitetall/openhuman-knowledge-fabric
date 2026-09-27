/**
 * `GET /session/assignments` — what a signed-in person may choose between when they pick the
 * context they act in: their live role assignments in one organization, and their clearance.
 *
 * The web application's context picker asked for three UUIDs typed by hand, because nothing
 * answered this question: the first person to sign in to a corpus-sized fixture (2026-09-24)
 * could not proceed without somebody reading ids out of the database for them. The answer is the
 * caller's own authority and nobody else's, established exactly as every other route establishes
 * it: the bearer token is verified and the person resolved by kf-attestor, each step attested,
 * and the database answers under that person's bound context.
 *
 *   headers  Authorization: Bearer <token>, x-kf-organization: <uuid>
 *   200      { organizationId, personId, clearance, assignments: [{ assignmentId, roleId,
 *              validTo }] }
 *   422      { error: 'no_live_assignment' }        — nothing to choose
 *   401/503  as every route answers an unidentified caller or an unreachable attestor
 *
 * `GET /session/contexts` answers the same, for every organization the person holds a live
 * assignment in, each with its legal name (20260926120000): the picker's menu, so a person of any
 * organization chooses without typing ids. Which organizations is the attestor's answer for the
 * verified token's own person, and nothing in the request can name another; each organization is
 * then described exactly as `GET /session/assignments` describes it, identified and read under
 * the person's own bound context there.
 *
 *   headers  Authorization: Bearer <token>
 *   200      { personId, organizations: [{ organizationId, legalName, clearance, assignments,
 *              refused }] }   — `refused` names why one organization could not be described
 *                               (its clearance or assignment was refused), with no assignments
 *   422      { error: 'no_live_assignment' }        — nothing to choose anywhere
 *   401/503  as `GET /session/assignments`
 *
 * It chooses nothing and saves nothing. The context is still selected by the person and
 * validated by the API before the web application keeps it; a person with one assignment still
 * says so. Deriving the assignment here uses the capture route's path (ADR 0034 §2): the person's
 * only one, or a refusal listing them, which this route turns into the list.
 */

import type { FastifyInstance } from 'fastify';
import { AttestorUnavailable, IdentityRejected, type IdentityFailure } from '@kf/authorization';
import { bindPrincipal, withTransaction, type Pool } from '@kf/database';
import { CallerRejected, attestorUnavailable, refuseUnidentified } from './actions/auth.js';
import type { Caller, IdentifyCaller, ListHoldings } from './actions/contracts.js';

export interface SessionRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
  /** Every live assignment the token's own person holds, across organizations. */
  readonly holdings: ListHoldings;
}

export interface SessionAssignment {
  readonly assignmentId: string;
  readonly roleId: string;
  readonly validTo: string | null;
}

export interface SessionAssignments {
  readonly organizationId: string;
  readonly personId: string;
  readonly clearance: string;
  readonly assignments: readonly SessionAssignment[];
}

/** One organization of `GET /session/contexts`: described, or the reason it could not be. */
export interface SessionContextOrganization {
  readonly organizationId: string;
  readonly legalName: string;
  /** Null exactly when `refused` is set. */
  readonly clearance: string | null;
  readonly assignments: readonly SessionAssignment[];
  readonly refused: IdentityFailure | null;
}

export interface SessionContexts {
  readonly personId: string;
  readonly organizations: readonly SessionContextOrganization[];
}

const RANKED = ['public', 'internal', 'confidential', 'restricted'] as const;

/**
 * Failures that are about the token or the person, not about one organization: any of them
 * refuses the whole answer, as it refuses every route, and lists nothing.
 */
const CALLER_FAILURES: ReadonlySet<IdentityFailure> = new Set<IdentityFailure>([
  'no_token',
  'invalid_token',
  'unknown_subject',
  'revoked_identity',
  'undeclared_agent',
]);

/** An error identifying answers for, as opposed to a defect, which is left to be a 500. */
function isIdentityFailure(error: unknown): boolean {
  return (
    error instanceof IdentityRejected ||
    error instanceof CallerRejected ||
    error instanceof AttestorUnavailable
  );
}

/**
 * The clearance and the live assignments in the organization `caller` was identified in at
 * `public`, read under the person's own bound context. Throws what identifying throws.
 */
async function describe(
  options: SessionRoutesOptions,
  asked: Record<string, unknown>,
  caller: Caller,
): Promise<SessionAssignments> {
  // The clearance: the highest ceiling the database will bind this person at. Asked the way
  // every request asks, so the answer is the resolver's (`org.resolve_effective_classification`)
  // and not a second reading of the clearance rows that could disagree with it.
  let clearance: string = 'public';
  let atClearance: Caller = caller;
  for (const level of [...RANKED].reverse()) {
    if (level === 'public') break;
    try {
      atClearance = await options.identify({
        headers: {
          ...asked,
          'x-kf-organization': caller.organizationId,
          'x-kf-acting-role': caller.actingRoleId,
          'x-kf-classification': level,
        },
      });
      clearance = level;
      break;
    } catch (error: unknown) {
      if (error instanceof IdentityRejected && error.failure === 'classification_not_granted') {
        continue;
      }
      throw error;
    }
  }

  // The assignments themselves are `internal` records: read at the clearance just learned.
  const assignments = await withTransaction(options.pool, async (tx) => {
    await bindPrincipal(tx, atClearance);
    return tx.query<{ id: string; role_id: string; valid_to: Date | null }>(
      `select /* session.assignments */ ra.id, ra.role_id, ra.valid_to
         from org.role_assignment ra
         join core.object envelope on envelope.id = ra.id
        where ra.subject_id = $1 and envelope.organization_id = $2
          and envelope.lifecycle_state = 'active'
          and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now())
        order by ra.valid_from, ra.id`,
      [atClearance.actorId, atClearance.organizationId],
    );
  });
  return {
    organizationId: atClearance.organizationId,
    personId: atClearance.actorId,
    clearance,
    assignments: assignments.map((row) => ({
      assignmentId: row.id,
      roleId: row.role_id,
      validTo: row.valid_to === null ? null : new Date(row.valid_to).toISOString(),
    })),
  };
}

export function registerSessionRoutes(app: FastifyInstance, options: SessionRoutesOptions): void {
  app.get('/session/assignments', async (request, reply) => {
    const headers = request.headers as Record<string, unknown>;
    // Identified at `public`, the one ceiling every cleared person holds, with no acting role:
    // the capture route's derivation, so a person with one assignment is identified outright.
    const asked = { ...headers, 'x-kf-acting-role': '', 'x-kf-classification': 'public' };
    let caller: Caller;
    try {
      caller = await options.identify({ headers: asked, deriveAssignment: true });
    } catch (error: unknown) {
      if (error instanceof IdentityRejected && error.failure === 'no_live_assignment') {
        return reply.code(422).send({ error: 'no_live_assignment', message: error.message });
      }
      if (
        !(error instanceof IdentityRejected) ||
        error.failure !== 'assignment_ambiguous' ||
        error.assignments === undefined ||
        error.assignments.length === 0
      ) {
        return refuseUnidentified(reply, error);
      }
      try {
        caller = await options.identify({
          headers: { ...asked, 'x-kf-acting-role': error.assignments[0]!.assignmentId },
        });
      } catch (retry: unknown) {
        return refuseUnidentified(reply, retry);
      }
    }
    let body: SessionAssignments;
    try {
      body = await describe(options, asked, caller);
    } catch (error: unknown) {
      if (!isIdentityFailure(error)) throw error;
      return refuseUnidentified(reply, error);
    }
    return reply.header('cache-control', 'private, no-store').send(body);
  });

  app.get('/session/contexts', async (request, reply) => {
    const headers = request.headers as Record<string, unknown>;
    // Only the bearer token decides whose holdings these are. Any x-kf-* header the request
    // carries is dropped rather than passed on: this route has no input naming a person, an
    // organization or an assignment.
    const bearer: Record<string, unknown> = { authorization: headers['authorization'] };
    let holdings;
    try {
      holdings = await options.holdings({ headers: bearer });
    } catch (error: unknown) {
      if (error instanceof IdentityRejected && error.failure === 'no_live_assignment') {
        return reply.code(422).send({ error: 'no_live_assignment', message: error.message });
      }
      return refuseUnidentified(reply, error);
    }

    const organizations: SessionContextOrganization[] = [];
    for (const held of holdings.organizations) {
      const first = held.assignments[0];
      if (first === undefined) continue;
      const asked = {
        ...bearer,
        'x-kf-organization': held.organizationId,
        'x-kf-acting-role': first.assignmentId,
        'x-kf-classification': 'public',
      };
      try {
        const caller = await options.identify({ headers: asked });
        if (caller.actorId !== holdings.personId || caller.organizationId !== held.organizationId) {
          // The attestor listed one person and identified another: a defect, never a menu.
          throw new Error('the attestor identified a different person or organization');
        }
        const described = await describe(options, asked, caller);
        organizations.push({
          organizationId: held.organizationId,
          legalName: held.legalName,
          clearance: described.clearance,
          assignments: described.assignments,
          refused: null,
        });
      } catch (error: unknown) {
        if (!isIdentityFailure(error)) throw error;
        if (error instanceof AttestorUnavailable) return attestorUnavailable(reply);
        if (!(error instanceof IdentityRejected) || CALLER_FAILURES.has(error.failure)) {
          return refuseUnidentified(reply, error);
        }
        organizations.push({
          organizationId: held.organizationId,
          legalName: held.legalName,
          clearance: null,
          assignments: [],
          refused: error.failure,
        });
      }
    }
    const body: SessionContexts = { personId: holdings.personId, organizations };
    return reply.header('cache-control', 'private, no-store').send(body);
  });
}
