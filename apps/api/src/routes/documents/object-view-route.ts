import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OBJECT_HISTORY_SQL } from '@kf/actions';
import { setResolvedAccessContext, withTransaction, type Tx } from '@kf/database';
import {
  claimMemberCount,
  claimMemberCountAmong,
  claimMembersAmong,
  enumerateNeighbourhoodGraph,
  enumeratePermittedSet,
  enumerateRelevanceGraph,
  latestMasterRecordClaim,
  masterRecordCurrency,
  type ClaimCurrency,
  type MasterRecordClaim,
} from '@kf/documents';
import {
  assertMemberBudget,
  bindParameters,
  isNeighbourhoodReading,
  neighbourhoodScope,
  project,
  projectNeighbourhood,
  ProjectionRefused,
  type ProjectionResult,
} from '@kf/projections';
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
 *
 * WHY IT READS ONE NEIGHBOURHOOD. The view used to load the claim's whole manifest, enumerate the
 * whole permitted set and the whole relation graph, and project all of it to show one record. For a
 * reader of ~50 000 records that was 12-16 s per view on the kf-fixa fixture (2026-09-26). It now
 * asks the database whether the claim is still current (answered from its record of writes when it
 * can be, by enumerating otherwise, `masterRecordCurrency`), then reads only the edges touching the
 * anchor and the claim's members among what they reach.
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
    //
    // "Current" means what it always has — the corpus has not moved since the claim — and is
    // asked first of the database's record of writes, which answers without enumerating the
    // corpus when the reader's own compilation saw every write since (20260926110100). Only
    // when it cannot is the whole permitted set enumerated and compared.
    const reader = { personId: identity.actorId, organizationId: identity.organizationId };
    const currencyOf = async (
      claim: MasterRecordClaim | undefined,
    ): Promise<ClaimCurrency | undefined> =>
      claim === undefined ? undefined : masterRecordCurrency(tx, reader, claim);
    let claim = await latestMasterRecordClaim(tx, identity.actorId, identity.organizationId);
    let currency = await currencyOf(claim);
    // The refresh also compiles a claim that is current but could only be shown so by
    // enumerating: the compilation reuses it (ADR 0013) and records that it looked, so the
    // views after it are answered from the record of writes again.
    const refreshable = currency?.current !== true || currency.basis !== 'recorded';
    if (currency?.current !== true || (mode.refresh && refreshable)) {
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
      claim = await latestMasterRecordClaim(tx, identity.actorId, identity.organizationId);
      currency = await currencyOf(claim);
      if (currency?.current !== true) return answer(409, { error: 'master_record_stale' });
    }
    if (claim === undefined) return answer(404, { error: 'master_record_not_found' });

    let result;
    try {
      result = isNeighbourhoodReading(definition)
        ? await readNeighbourhood(tx, definition, request.params.id, claim, currency)
        : await readWholeClaim(tx, definition, request.params.id, claim, currency);
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
    if (result === 'stale') return answer(409, { error: 'master_record_stale' });

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

type CurrentClaim = Extract<ClaimCurrency, { current: true }>;
type ProjectionDefinition = NonNullable<
  ReturnType<NonNullable<DocumentRoutesOptions['projections']>['byId']>
>;

/**
 * The `object_view` Result over the anchor's neighbourhood only — the Result the whole claim gives
 * (`projectNeighbourhood`; tests/database/object-view-scoped.test.ts compares the two): the edges a
 * walk from the anchor can cross, the claim's members among what it reaches, and the claim's size
 * to count the rest. Each included member shown is re-checked live under the reader's own rules at
 * the revision the claim holds; a difference is a moved corpus and answers `stale`, whatever said
 * the claim was current.
 */
async function readNeighbourhood(
  tx: Tx,
  definition: ProjectionDefinition,
  objectId: string,
  claim: MasterRecordClaim,
  currency: CurrentClaim,
): Promise<ProjectionResult | 'stale'> {
  // Refuse a malformed id before it reaches SQL, exactly as the engine would.
  const parameters = bindParameters(definition, { object_id: objectId });
  const graph = await enumerateNeighbourhoodGraph(
    tx,
    String(parameters['object_id']),
    definition.traverse?.maxDepth ?? 0,
  );
  const scope = [...neighbourhoodScope(definition, parameters, graph)];
  // A hub can touch more records than the reading may hold: refuse it by counting, before a
  // single payload is loaded.
  if (scope.length > definition.budgets.maxMembers) {
    assertMemberBudget(definition, await claimMemberCountAmong(tx, claim, currency.members, scope));
  }
  const members = await claimMembersAmong(tx, claim, currency.members, scope);
  const shown = members.included.map((member) => member.objectId);
  const live =
    currency.permitted ??
    (shown.length === 0
      ? []
      : await enumeratePermittedSet(
          tx,
          claim.personId,
          claim.organizationId,
          currency.memberFormat,
          shown,
        ));
  const liveDigest = new Map(live.map((member) => [member.objectId, member.contentDigest]));
  if (members.included.some((member) => liveDigest.get(member.objectId) !== member.contentDigest)) {
    return 'stale';
  }
  return projectNeighbourhood({
    definition,
    parameters,
    corpus: {
      personId: claim.personId,
      organizationId: claim.organizationId,
      corpusDigest: claim.corpusDigest,
      members: projectionMembersOf(members, liveVerifications(live)),
      corpusMemberCount: await claimMemberCount(tx, claim, currency.members),
    },
    graph,
  });
}

/**
 * A definition that could place a member outside the anchor's neighbourhood is evaluated over the
 * whole claim and the whole graph, as every Object View was before the neighbourhood reading.
 */
async function readWholeClaim(
  tx: Tx,
  definition: ProjectionDefinition,
  objectId: string,
  claim: MasterRecordClaim,
  currency: CurrentClaim,
): Promise<ProjectionResult> {
  const everyMember = await tx.query<{ object_id: string }>(
    'select object_id from content.master_record_item where master_record_id = $1',
    [claim.id],
  );
  const members = await claimMembersAmong(
    tx,
    claim,
    currency.members,
    currency.members.kind === 'manifest'
      ? [...currency.members.included, ...currency.members.withdrawn].map((m) => m.objectId)
      : everyMember.map((row) => row.object_id),
  );
  const permitted =
    currency.permitted ??
    (await enumeratePermittedSet(tx, claim.personId, claim.organizationId, currency.memberFormat));
  return project({
    definition,
    parameters: { object_id: objectId },
    corpus: {
      personId: claim.personId,
      organizationId: claim.organizationId,
      corpusDigest: claim.corpusDigest,
      members: projectionMembersOf(members, liveVerifications(permitted)),
    },
    graph: await enumerateRelevanceGraph(tx),
  });
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
