import type { FastifyInstance } from 'fastify';
import { setResolvedAccessContext, withTransaction } from '@kf/database';
import {
  assertPermissionSetInvariant,
  enumeratePermittedSet,
  enumerateRelevanceGraph,
  latestMasterRecord,
  type MasterRecordManifest,
} from '@kf/documents';
import { project, ProjectionRefused, type ProjectionCorpus } from '@kf/projections';
import { unidentified } from '../actions.js';
import type { DocumentRoutesOptions } from './contracts.js';
import { projectionMembersOf } from './master-record-projection-route.js';

/**
 * `GET /objects/:id` — the Object View.
 *
 * Members and relationships are the `object_view` projection evaluated over the reader's own
 * master record, anchored at the object: one engine, the same ⊆-corpus guarantee as every
 * other reading. History and available actions are facets, read from the audit chain and the
 * state machines by the same queries `/objects/:id/history` and
 * `/objects/:id/available-actions` use — they are not corpus members, so they are not
 * projected. Every object type gets this page with no per-type code.
 */
export function registerObjectViewRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get<{ Params: { id: string } }>('/objects/:id', async (request, reply) => {
    const definition = options.projections?.byId('object_view');
    if (definition === undefined) {
      return reply
        .code(503)
        .send({ error: 'projections_unavailable', message: 'no compiled object_view definition' });
    }
    let identity;
    try {
      identity = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }

    return withTransaction(options.pool, async (tx) => {
      await setResolvedAccessContext(tx, {
        subjectId: identity.actorId,
        assignmentId: identity.actingRoleId,
        organizationId: identity.organizationId,
        requestedClassification: identity.maxClassification,
      });
      const record = await latestMasterRecord(tx, identity.actorId, identity.organizationId);
      if (record === undefined) return reply.code(404).send({ error: 'master_record_not_found' });
      const manifest = record['manifest'] as MasterRecordManifest;
      const included = Array.isArray(manifest.included) ? manifest.included : [];
      const withdrawn = Array.isArray(manifest.withdrawn) ? manifest.withdrawn : [];

      const permitted = await enumeratePermittedSet(tx, identity.actorId, identity.organizationId);
      try {
        assertPermissionSetInvariant(
          { corpusDigest: String(record['corpus_digest']), included, withdrawn },
          permitted,
        );
      } catch {
        return reply.code(409).send({ error: 'master_record_stale' });
      }

      const corpus: ProjectionCorpus = {
        personId: identity.actorId,
        organizationId: identity.organizationId,
        corpusDigest: String(record['corpus_digest']),
        members: projectionMembersOf({ included, withdrawn }),
      };
      let result;
      try {
        result = project({
          definition,
          parameters: { object_id: request.params.id },
          corpus,
          graph: await enumerateRelevanceGraph(tx),
        });
      } catch (error: unknown) {
        if (error instanceof ProjectionRefused) {
          // An anchor outside the corpus reads as not found, not as a different error: the
          // reader cannot learn whether it exists for somebody else.
          if (error.reason === 'foreign_member')
            return reply.code(404).send({ error: 'not_found' });
          return reply
            .code(error.reason === 'budget_exceeded' ? 413 : 400)
            .send({ error: 'projection_refused', reason: error.reason, message: error.message });
        }
        throw error;
      }

      const history = await tx.query<Record<string, unknown>>(
        `select e.seq, e.action_type, e.actor_id, e.acting_role_id, e.recorded_at,
                e.effective_at, e.reason, e.digest
           from core.audit_event e
          where e.object_id = $1 or $1 = any(
                  select unnest(a.target_ids) from core.action a where a.id = e.action_id)
          order by e.seq`,
        [request.params.id],
      );
      const subject = result.sections[0]?.members[0];
      const transitions =
        subject === undefined
          ? []
          : await tx.query<{ action_id: string; to_state: string }>(
              `select action_id, to_state from registry.state_transition
                where object_type = $1 and from_state = $2 order by action_id, to_state`,
              [subject.objectType, subject.lifecycleState ?? ''],
            );
      const byAction = new Map<string, string[]>();
      for (const row of transitions) {
        byAction.set(row.action_id, [...(byAction.get(row.action_id) ?? []), row.to_state]);
      }

      return reply.header('x-kf-projection-digest', result.projectionDigest).send({
        result,
        facets: {
          history: { objectId: request.params.id, events: history },
          availableActions: [...byAction.entries()].map(([actionType, toStates]) => ({
            actionType,
            toStates,
            requiresChoice: toStates.length > 1,
          })),
        },
      });
    });
  });
}
