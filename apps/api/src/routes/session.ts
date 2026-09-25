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
 * It chooses nothing and saves nothing. The context is still selected by the person and
 * validated by the API before the web application keeps it; a person with one assignment still
 * says so. Deriving the assignment here uses the capture route's path (ADR 0034 §2): the person's
 * only one, or a refusal listing them, which this route turns into the list.
 */

import type { FastifyInstance } from 'fastify';
import { IdentityRejected } from '@kf/authorization';
import { bindPrincipal, withTransaction, type Pool } from '@kf/database';
import { refuseUnidentified } from './actions/auth.js';
import type { Caller, IdentifyCaller } from './actions/contracts.js';

export interface SessionRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
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

const RANKED = ['public', 'internal', 'confidential', 'restricted'] as const;

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
        return refuseUnidentified(reply, error);
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
    const body: SessionAssignments = {
      organizationId: atClearance.organizationId,
      personId: atClearance.actorId,
      clearance,
      assignments: assignments.map((row) => ({
        assignmentId: row.id,
        roleId: row.role_id,
        validTo: row.valid_to === null ? null : new Date(row.valid_to).toISOString(),
      })),
    };
    return reply.header('cache-control', 'private, no-store').send(body);
  });
}
