/**
 * Needs you: what waits on the bound person, and the one gesture that answers each item
 * (ADR 0040 decisions 5 and 6, SAS §24B, KF-SAS-RQ-263 to RQ-266; 20261007100000).
 *
 *   GET  /needs-you
 *        → { toVerify, awaitingOthers, proposals, policies }
 *   POST /needs-you/verify                     { recordId, expectedVersion, reason, idempotencyKey }
 *   POST /needs-you/proposals/:id/confirm      { idempotencyKey }
 *   POST /needs-you/proposals/:id/decline      { reason, idempotencyKey }
 *   GET  /verification-policies                → the policies in force in the organization
 *   GET  /objects/:id/verification             → one record's verification, as every read labels it
 *
 * WHAT IS LISTED, and every list is what the caller's row security and read grants reach and
 * nothing else (KF-SAS-RQ-262):
 *
 *   toVerify        unverified records an agent wrote that this person may verify: someone else
 *                   created them, and their acting assignment carries the verifying authority
 *                   (`technical_authority` at the organization or the record — the same check
 *                   `verify_record` makes, which runs again on the click).
 *   awaitingOthers  unverified records written by agents acting for this person: they cannot
 *                   verify their own (KF-SAS-RQ-230), so these wait for someone else; listed so
 *                   the person sees what their agents submitted.
 *   proposals       institutional acts this person's agents proposed, not yet answered.
 *
 * Qualification evidence joins the list when M5 builds it (KF-WAR-0007).
 *
 * THE GESTURES DECIDE NOTHING. Verify dispatches one `verify_record` at `reviewed_individually`,
 * with the row version the person read: the panel shows the verify button only on a record the
 * person opened, and the version proves which revision they opened (SAS §100.26 — paced, not
 * proven). Select-many is `POST /verifications/bulk`, recorded `promoted_in_bulk`. Confirm
 * dispatches the proposed act exactly as proposed, on the person's own token, so every check —
 * act grant, step-up, state, the database's agent bar — runs at that moment; then records the
 * resolution, which the database accepts only for that act (KF-AGENT-005). A proposal never
 * becomes an act any other way. An agent's token is refused all three by name, and the database
 * refuses them again (KF-AGENT-002, KF-AGENT-001).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  DEFAULT_STEP_UP,
  proposalRequest,
  readGranted,
  readGrantedSubset,
  readProposal,
  satisfiesStepUp,
  type PendingProposal,
  type StepUpPolicy,
} from '@kf/authorization';
import { bindPrincipal, PrincipalRefused, withTransaction, type Pool, type Tx } from '@kf/database';
import { recordVerification, type RecordVerification } from '@kf/domain';
import { refuseUnidentified } from './actions/auth.js';
import type { ActionRoutesOptions, Caller, IdentifyCaller } from './actions/contracts.js';
import { actionRejectionBody } from './actions/errors.js';

export interface NeedsYouRoutesOptions {
  readonly pool: Pool;
  readonly execute: ActionRoutesOptions['execute'];
  readonly identify: IdentifyCaller;
  /** Step-up per action type, applied to a confirmed proposal as the action route applies it. */
  readonly stepUp?: Readonly<Record<string, StepUpPolicy>>;
  /** Whether callers are identified by verified tokens (step-up applies only then). */
  readonly bearer: boolean;
}

/** The most items any one list carries; `total` says how many there are. */
export const NEEDS_YOU_LIMIT = 200;

/** The role whose holder may verify (`verify_record`'s own check, KF-DOC-AUTH-001/002). */
const VERIFYING_ROLE = 'technical_authority';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface NeedsYouRecord {
  readonly id: string;
  readonly objectType: string;
  readonly title: string;
  readonly classification: string;
  readonly lifecycleState: string;
  /** The version a verify must name: the one the person opened. */
  readonly rowVersion: number;
  /** The declared agent whose act wrote it most recently. */
  readonly agentClientId: string;
  /** The person that agent acted for. */
  readonly writtenFor: string;
  readonly writtenAt: string;
  readonly verification: RecordVerification;
}

export interface NeedsYouProposal {
  readonly id: string;
  readonly actionType: string;
  readonly targetIds: readonly string[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly reason: string | null;
  readonly agentClientId: string;
  readonly proposedAt: string;
  /** False when the caller is acting under another assignment than the proposal was made for. */
  readonly confirmableHere: boolean;
}

export interface NeedsYou {
  readonly person: string;
  readonly organizationId: string;
  readonly toVerify: { readonly items: readonly NeedsYouRecord[]; readonly total: number };
  readonly awaitingOthers: { readonly items: readonly NeedsYouRecord[]; readonly total: number };
  readonly proposals: { readonly items: readonly NeedsYouProposal[]; readonly total: number };
}

interface TouchedRow extends Record<string, unknown> {
  id: string;
  object_type: string;
  title: string;
  classification: string;
  lifecycle_state: string;
  row_version: string;
  created_by: string;
  agent_participation: string;
  actor_id: string;
  recorded_at: Date;
}

/**
 * Unverified records an agent's act wrote, newest act first, under the caller's row security.
 * `propose_act`, `set_verification_policy`, `resolve_act_proposal` and `compile_master_record` name
 * records without writing them, so they are not read; nor is the organization's own record.
 */
async function unverifiedAgentRecords(tx: Tx, caller: Caller): Promise<TouchedRow[]> {
  return tx.query<TouchedRow>(
    `with touched as (
       select distinct on (t.id) t.id, a.agent_participation, a.actor_id, a.recorded_at
         from core.action a
        cross join lateral unnest(a.target_ids) as t(id)
        where a.organization_id = $1
          and a.agent_participation is not null
          and a.action_type not in ('propose_act', 'set_verification_policy',
                                    'resolve_act_proposal', 'compile_master_record')
        order by t.id, a.recorded_at desc
     )
     select /* needs-you.unverified-agent-records */
            o.id, o.object_type, o.title, o.classification, o.lifecycle_state,
            o.row_version::text as row_version, o.created_by::text as created_by,
            touched.agent_participation, touched.actor_id::text as actor_id, touched.recorded_at
       from touched
       join core.object o on o.id = touched.id
      where o.object_type <> 'organization'
        and not exists (select 1 from core.object_verification v where v.object_id = o.id)
      order by touched.recorded_at desc, o.id`,
    [caller.organizationId],
  );
}

/** Whether the caller's acting assignment carries the verifying authority, and where. */
async function verifyingScope(tx: Tx, caller: Caller): Promise<string | undefined> {
  const assignment = await tx.maybeOne<{ role_id: string; scope_id: string }>(
    `select role_id, scope_id from org.role_assignment
      where id = $1 and subject_id = $2
        and valid_from <= now() and (valid_to is null or valid_to > now())`,
    [caller.actingRoleId, caller.actorId],
  );
  return assignment?.role_id === VERIFYING_ROLE ? assignment.scope_id : undefined;
}

function asRecord(row: TouchedRow): NeedsYouRecord {
  return {
    id: row.id,
    objectType: row.object_type,
    title: row.title,
    classification: row.classification,
    lifecycleState: row.lifecycle_state,
    rowVersion: Number(row.row_version),
    agentClientId: row.agent_participation,
    writtenFor: row.actor_id,
    writtenAt: row.recorded_at.toISOString(),
    verification: recordVerification(undefined),
  };
}

function asProposal(caller: Caller, proposal: PendingProposal): NeedsYouProposal {
  return {
    id: proposal.id,
    actionType: proposal.actionType,
    targetIds: proposal.targetIds,
    payload: proposal.payload,
    reason: proposal.reason,
    agentClientId: proposal.agentClientId,
    proposedAt: proposal.proposedAt,
    confirmableHere: proposal.actingRoleId === caller.actingRoleId,
  };
}

/** Everything that waits on the bound person. The caller must already be bound. */
export async function needsYou(tx: Tx, caller: Caller): Promise<NeedsYou> {
  const scope = await verifyingScope(tx, caller);
  const granted = await readGrantedSubset(tx, caller, await unverifiedAgentRecords(tx, caller));
  const toVerify: NeedsYouRecord[] = [];
  const awaitingOthers: NeedsYouRecord[] = [];
  for (const row of granted) {
    if (row.created_by === caller.actorId) {
      awaitingOthers.push(asRecord(row));
    } else if (
      caller.agent === undefined &&
      scope !== undefined &&
      (scope === caller.organizationId || scope === row.id)
    ) {
      toVerify.push(asRecord(row));
    }
  }
  const proposalIds = await tx.query<{ id: string }>(
    `select /* needs-you.pending-proposals */ p.id
       from core.act_proposal p
      where not exists (select 1 from core.act_proposal_resolution r where r.proposal_id = p.id)
      order by p.proposed_at desc, p.id`,
  );
  const proposals: NeedsYouProposal[] = [];
  for (const { id } of proposalIds.slice(0, NEEDS_YOU_LIMIT)) {
    const proposal = await readProposal(tx, id);
    if (proposal !== undefined) proposals.push(asProposal(caller, proposal));
  }
  return {
    person: caller.actorId,
    organizationId: caller.organizationId,
    toVerify: { items: toVerify.slice(0, NEEDS_YOU_LIMIT), total: toVerify.length },
    awaitingOthers: {
      items: awaitingOthers.slice(0, NEEDS_YOU_LIMIT),
      total: awaitingOthers.length,
    },
    proposals: { items: proposals, total: proposalIds.length },
  };
}

async function bound<T>(
  pool: Pool,
  caller: Caller,
  body: (tx: Tx) => Promise<T>,
): Promise<T | undefined> {
  return withTransaction(pool, async (tx) => {
    try {
      await bindPrincipal(tx, caller);
    } catch (error: unknown) {
      if (error instanceof PrincipalRefused) return undefined;
      throw error;
    }
    return body(tx);
  });
}

/** An agent's token may read Needs you; it may never answer it. */
function refuseAgent(
  reply: FastifyReply,
  caller: Caller,
  gesture: string,
): FastifyReply | undefined {
  if (caller.agent === undefined) return undefined;
  return reply.code(403).send({
    error: 'agent_cannot_answer',
    message:
      `${gesture} is the person's own judgement; an agent acting for them (${caller.agent}) ` +
      'may submit and propose, and the person answers here (KF-SAS-RQ-263, RQ-265)',
  });
}

function idempotencyKeyOf(body: Record<string, unknown>, max = 91): string | undefined {
  const key = body['idempotencyKey'];
  return typeof key === 'string' && key.length >= 8 && key.length <= max ? key : undefined;
}

export function registerNeedsYouRoutes(app: FastifyInstance, options: NeedsYouRoutesOptions): void {
  const stepUp = options.stepUp ?? DEFAULT_STEP_UP;

  const identify = async (request: { headers: unknown }, reply: FastifyReply) => {
    try {
      return await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (err: unknown) {
      refuseUnidentified(reply, err);
      return undefined;
    }
  };

  app.get('/needs-you', async (request, reply) => {
    const caller = await identify(request, reply);
    if (caller === undefined) return reply;
    const answer = await bound(options.pool, caller, (tx) => needsYou(tx, caller));
    if (answer === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply.send(answer);
  });

  app.get('/verification-policies', async (request, reply) => {
    const caller = await identify(request, reply);
    if (caller === undefined) return reply;
    const policies = await bound(options.pool, caller, (tx) =>
      tx.query<{
        id: string;
        object_type: string;
        action_type: string;
        agent_client_id: string;
        mode: string;
        reason: string;
        set_by: string;
        set_at: Date;
      }>(
        `select distinct on (object_type, action_type, agent_client_id)
                id, object_type, action_type, agent_client_id, mode, reason,
                set_by::text as set_by, set_at
           from core.verification_policy
          order by object_type, action_type, agent_client_id, revision desc`,
      ),
    );
    if (policies === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply.send({
      organizationId: caller.organizationId,
      // Absence of a row for a kind, act and agent is `required`: a person verifies.
      default: 'required',
      policies: policies.map((p) => ({
        id: p.id,
        objectType: p.object_type,
        actionType: p.action_type,
        agentClientId: p.agent_client_id,
        mode: p.mode,
        reason: p.reason,
        setBy: p.set_by,
        setAt: p.set_at.toISOString(),
      })),
    });
  });

  // One record's verification, under the read gate (ADR 0027): what a submitting agent, or the
  // panel after a click, asks without compiling a master record. Not found reads as every other.
  app.get<{ Params: { id: string } }>('/objects/:id/verification', async (request, reply) => {
    const caller = await identify(request, reply);
    if (caller === undefined) return reply;
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not_found' });
    const found = await bound(options.pool, caller, async (tx) => {
      if (!(await readGranted(tx, caller, request.params.id))) return null;
      const row = await tx.maybeOne<{
        basis: string;
        verified_at: Date;
        verified_by: string;
        policy_id: string | null;
      }>(
        `select basis, verified_at, verified_by::text as verified_by, policy_id::text as policy_id
           from core.object_verification where object_id = $1`,
        [request.params.id],
      );
      return recordVerification(
        row === undefined
          ? undefined
          : {
              basis: row.basis,
              verifiedAt: row.verified_at,
              verifiedBy: row.verified_by,
              policyId: row.policy_id,
            },
      );
    });
    if (found === undefined || found === null) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ recordId: request.params.id, verification: found });
  });

  app.post<{ Body: Record<string, unknown> }>('/needs-you/verify', async (request, reply) => {
    const caller = await identify(request, reply);
    if (caller === undefined) return reply;
    const refused = refuseAgent(reply, caller, 'verifying a record');
    if (refused !== undefined) return refused;
    const body = request.body ?? {};
    const recordId = body['recordId'];
    const expectedVersion = body['expectedVersion'];
    const key = idempotencyKeyOf(body);
    if (typeof recordId !== 'string' || !UUID.test(recordId)) {
      return reply.code(400).send({ error: 'invalid_record_id', message: 'recordId is a uuid' });
    }
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion)) {
      return reply.code(400).send({
        error: 'expected_version_required',
        message:
          'expectedVersion is the row version of the record as you opened it; an individual ' +
          'review is of a revision you read. To verify many without opening each, use ' +
          'POST /verifications/bulk, which records them as promoted_in_bulk',
      });
    }
    if (key === undefined) {
      return reply
        .code(400)
        .send({ error: 'idempotency_key_required', message: 'idempotencyKey, 8 to 91 characters' });
    }
    try {
      const result = await options.execute({
        actionType: 'verify_record',
        actorId: caller.actorId,
        actingRoleId: caller.actingRoleId,
        organizationId: caller.organizationId,
        maxClassification: caller.maxClassification,
        attestation: caller.attestation,
        targetIds: [recordId],
        expectedVersion,
        idempotencyKey: key,
        requestId: String(request.id),
        ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
        payload: { basis: 'reviewed_individually' },
      });
      return reply.code(result.replayed ? 200 : 201).send({
        recordId,
        actionId: result.actionId,
        replayed: result.replayed,
        basis: 'reviewed_individually',
      });
    } catch (err: unknown) {
      const refusal = actionRejectionBody(err);
      if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
      throw err;
    }
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/needs-you/proposals/:id/confirm',
    async (request, reply) => {
      const caller = await identify(request, reply);
      if (caller === undefined) return reply;
      const refused = refuseAgent(reply, caller, 'confirming a proposed act');
      if (refused !== undefined) return refused;
      const proposal = await bound(options.pool, caller, (tx) =>
        readProposal(tx, request.params.id),
      );
      if (proposal === undefined) return reply.code(404).send({ error: 'not_found' });
      if (proposal.resolution !== null) {
        return reply.code(409).send({
          error: 'proposal_resolved',
          message: `this proposal was already ${proposal.resolution}`,
        });
      }
      if (proposal.actingRoleId !== caller.actingRoleId) {
        return reply.code(409).send({
          error: 'assignment_mismatch',
          message:
            'the proposal was made for you acting under another assignment; switch to it to ' +
            'confirm, so the act you perform is the one proposed',
          detail: { actingRoleId: proposal.actingRoleId },
        });
      }
      // Step-up, as POST /actions applies it to this action type: a confirmed proposal is the
      // person's own act and meets every bar that act meets.
      const policy = options.bearer ? stepUp[proposal.actionType] : undefined;
      if (policy !== undefined) {
        const outcome = satisfiesStepUp(caller.authentication, policy);
        if (!outcome.satisfied) {
          return reply
            .code(401)
            .header(
              'www-authenticate',
              `Bearer error="insufficient_user_authentication", max_age=${policy.maxAgeSeconds ?? 0}`,
            )
            .send({
              error: 'step_up_required',
              message: outcome.detail ?? 'this action requires a stronger authentication',
              detail: { failure: outcome.failure, actionType: proposal.actionType },
            });
        }
      }
      const key = `proposal:${proposal.id}`;
      try {
        const performed = await options.execute({
          ...proposalRequest(
            {
              actionType: proposal.actionType,
              targetIds: proposal.targetIds,
              payload: proposal.payload,
              ...(proposal.reason === null ? {} : { reason: proposal.reason }),
            },
            caller,
            key,
          ),
          attestation: caller.attestation,
          requestId: String(request.id),
        });
        const resolved = await options.execute({
          actionType: 'resolve_act_proposal',
          actorId: caller.actorId,
          actingRoleId: caller.actingRoleId,
          organizationId: caller.organizationId,
          maxClassification: caller.maxClassification,
          attestation: caller.attestation,
          targetIds:
            proposal.targetIds.length > 0 ? [...proposal.targetIds] : [caller.organizationId],
          idempotencyKey: `${key}:resolution`,
          requestId: String(request.id),
          payload: {
            proposal_id: proposal.id,
            resolution: 'confirmed',
            performed_action: performed.actionId,
          },
        });
        return reply.code(201).send({
          proposalId: proposal.id,
          resolution: 'confirmed',
          performedAction: performed.actionId,
          resolutionAction: resolved.actionId,
          objectIds: performed.objectIds,
        });
      } catch (err: unknown) {
        const refusal = actionRejectionBody(err);
        if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/needs-you/proposals/:id/decline',
    async (request, reply) => {
      const caller = await identify(request, reply);
      if (caller === undefined) return reply;
      const refused = refuseAgent(reply, caller, 'declining a proposed act');
      if (refused !== undefined) return refused;
      const body = request.body ?? {};
      const key = idempotencyKeyOf(body);
      if (key === undefined) {
        return reply.code(400).send({
          error: 'idempotency_key_required',
          message: 'idempotencyKey, 8 to 91 characters',
        });
      }
      const proposal = await bound(options.pool, caller, (tx) =>
        readProposal(tx, request.params.id),
      );
      if (proposal === undefined) return reply.code(404).send({ error: 'not_found' });
      try {
        const resolved = await options.execute({
          actionType: 'resolve_act_proposal',
          actorId: caller.actorId,
          actingRoleId: caller.actingRoleId,
          organizationId: caller.organizationId,
          maxClassification: caller.maxClassification,
          attestation: caller.attestation,
          targetIds:
            proposal.targetIds.length > 0 ? [...proposal.targetIds] : [caller.organizationId],
          idempotencyKey: key,
          requestId: String(request.id),
          ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
          payload: { proposal_id: proposal.id, resolution: 'declined' },
        });
        return reply.code(resolved.replayed ? 200 : 201).send({
          proposalId: proposal.id,
          resolution: 'declined',
          resolutionAction: resolved.actionId,
        });
      } catch (err: unknown) {
        const refusal = actionRejectionBody(err);
        if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
        throw err;
      }
    },
  );
}
