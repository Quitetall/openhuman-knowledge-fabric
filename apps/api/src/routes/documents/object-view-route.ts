import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OBJECT_HISTORY_SQL } from '@kf/actions';
import { setResolvedAccessContext, withTransaction } from '@kf/database';
import {
  assertPermissionSetInvariant,
  CURRENT_MASTER_RECORD_MEMBER_FORMAT,
  enumeratePermittedSet,
  masterRecordMemberFormat,
  enumerateRelevanceGraph,
  latestMasterRecord,
  type MasterRecordManifest,
} from '@kf/documents';
import { project, ProjectionRefused, type ProjectionCorpus } from '@kf/projections';
import { refuseUnidentified } from '../actions.js';
import { actionRejectionBody } from '../actions/errors.js';
import type { DocumentRoutesOptions } from './contracts.js';
import { liveVerifications, projectionMembersOf } from './master-record-projection-route.js';

/**
 * `GET /objects/:id` — the Object View — and `POST /objects/:id/refresh`, the same view after
 * bringing the reader's master record up to date.
 *
 * Members and relationships are the `object_view` projection evaluated over the reader's own
 * master record, anchored at the object: one engine, the same ⊆-corpus guarantee as every
 * other reading. History and available actions are facets, read from the audit chain and the
 * state machines by the same queries `/objects/:id/history` and
 * `/objects/:id/available-actions` use — they are not corpus members, so they are not
 * projected. Every object type gets this page with no per-type code.
 *
 * WHY TWO ROUTES. The GET used to compile a stale claim itself. Compiling is an act, recorded
 * as the reader, and a GET is what a link is: the web page behind it is reachable by a
 * top-level cross-site navigation, which carries the Lax session cookie, so any site could make
 * a signed-in person perform a recorded act by linking to an object. The GET is now
 * side-effect free and answers `409 master_record_stale`; the refresh is a POST, which the web
 * sends only from its own form (a server action, origin-checked by Next).
 */
export function registerObjectViewRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get<{ Params: { id: string } }>('/objects/:id', async (request, reply) =>
    serveObjectView(options, request, reply, { refresh: false }),
  );
  app.post<{ Params: { id: string } }>('/objects/:id/refresh', async (request, reply) =>
    serveObjectView(options, request, reply, { refresh: true }),
  );
}

async function serveObjectView(
  options: DocumentRoutesOptions,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
  mode: { readonly refresh: boolean },
): Promise<FastifyReply> {
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
    return refuseUnidentified(reply, error);
  }

  // Everything below runs in one transaction and only DESCRIBES the reply; the reply is
  // sent after the commit. Sending from inside the transaction served a refreshed claim the
  // reader could not yet see on their next request (found by the test for exactly that).
  const outcome = await withTransaction(options.pool, async (tx): Promise<Outcome> => {
    await setResolvedAccessContext(tx, {
      subjectId: identity.actorId,
      assignmentId: identity.actingRoleId,
      organizationId: identity.organizationId,
      requestedClassification: identity.maxClassification,
      attestation: identity.attestation,
    });
    // An Object View is a reading over the viewer's master record, so it needs a current
    // claim. On the refresh POST, an absent or stale claim is compiled — as an act, as them,
    // recorded — and then the view answers. On the GET it is reported instead, so the
    // person is offered the refresh rather than having it done to them by whoever sent the
    // link. (The fixture workflow, 2026-09-11, found every view answering 409 after any
    // corpus change with no way forward; the POST is that way forward.)
    let record = await latestMasterRecord(tx, identity.actorId, identity.organizationId);
    // Under the member format the claim RECORDED (KF-SAS-RQ-016); with no claim yet, the
    // current one, which is what a compilation will write.
    const permittedFor = (
      claim: Record<string, unknown> | undefined,
    ): ReturnType<typeof enumeratePermittedSet> =>
      enumeratePermittedSet(
        tx,
        identity.actorId,
        identity.organizationId,
        claim === undefined
          ? CURRENT_MASTER_RECORD_MEMBER_FORMAT
          : masterRecordMemberFormat(claim['manifest']),
      );
    let permitted = await permittedFor(record);
    const current = (claim: Record<string, unknown> | undefined): boolean => {
      if (claim === undefined) return false;
      const m = claim['manifest'] as MasterRecordManifest;
      try {
        assertPermissionSetInvariant(
          {
            corpusDigest: String(claim['corpus_digest']),
            included: Array.isArray(m.included) ? m.included : [],
            withdrawn: Array.isArray(m.withdrawn) ? m.withdrawn : [],
          },
          permitted,
        );
        return true;
      } catch {
        return false;
      }
    };
    if (!current(record)) {
      if (!mode.refresh) {
        return answer(409, {
          error: 'master_record_stale',
          message:
            'Your master record is out of date for this view. POST /objects/:id/refresh ' +
            'compiles it (a recorded act) and returns the view.',
        });
      }
      try {
        await options.executeInTransaction(tx, {
          actionType: 'compile_master_record',
          actorId: identity.actorId,
          actingRoleId: identity.actingRoleId,
          organizationId: identity.organizationId,
          maxClassification: identity.maxClassification,
          attestation: identity.attestation,
          targetIds: [identity.actorId],
          // Random on purpose: this is not a retry of anything. Two views racing on the
          // same stale claim both compile; the second finds the corpus unchanged and reuses
          // the claim the first made (ADR 0013), so nothing is recorded twice.
          idempotencyKey: `object-view-refresh:${crypto.randomUUID()}`,
          requestId: String(request.id),
          reason: 'master record refreshed on demand to serve an Object View',
        });
      } catch (error: unknown) {
        const refusal = actionRejectionBody(error);
        if (refusal !== undefined) return answer(refusal.status, refusal.body);
        throw error;
      }
      record = await latestMasterRecord(tx, identity.actorId, identity.organizationId);
      permitted = await permittedFor(record);
      if (!current(record)) return answer(409, { error: 'master_record_stale' });
    }
    if (record === undefined) return answer(404, { error: 'master_record_not_found' });
    const manifest = record['manifest'] as MasterRecordManifest;
    const included = Array.isArray(manifest.included) ? manifest.included : [];
    const withdrawn = Array.isArray(manifest.withdrawn) ? manifest.withdrawn : [];

    const corpus: ProjectionCorpus = {
      personId: identity.actorId,
      organizationId: identity.organizationId,
      corpusDigest: String(record['corpus_digest']),
      members: projectionMembersOf({ included, withdrawn }, liveVerifications(permitted)),
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
      if (error instanceof ProjectionRefused && error.reason !== 'unlabelled_member') {
        // An anchor outside the corpus reads as not found, not as a different error: the
        // reader cannot learn whether it exists for somebody else.
        if (error.reason === 'foreign_member') return answer(404, { error: 'not_found' });
        return answer(error.reason === 'budget_exceeded' ? 413 : 400, {
          error: 'projection_refused',
          reason: error.reason,
          message: error.message,
        });
      }
      throw error;
    }

    const history = await tx.query<Record<string, unknown>>(OBJECT_HISTORY_SQL, [
      request.params.id,
    ]);
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

    return answer(
      200,
      {
        result,
        facets: {
          history: { objectId: request.params.id, events: history },
          availableActions: [...byAction.entries()].map(([actionType, toStates]) => ({
            actionType,
            toStates,
            requiresChoice: toStates.length > 1,
          })),
        },
      },
      { 'x-kf-projection-digest': result.projectionDigest },
    );
  });
  for (const [name, value] of Object.entries(outcome.headers ?? {})) reply.header(name, value);
  return reply.code(outcome.status).send(outcome.body);
}

interface Outcome {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

function answer(
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): Outcome {
  return headers === undefined ? { status, body } : { status, body, headers };
}
