/**
 * Joining and qualification on the wire (ADR 0038; ADR 0040 decision 12; SAS §24A, §24B,
 * KF-SAS-RQ-254 to RQ-261, RQ-275).
 *
 *   GET  /start-here                         the reader's own records in force, each as its
 *                                            generated Start Here (`kf-start-here-v1`), oldest
 *                                            first; an empty list when they hold none
 *   GET  /start-here/guide                   the agent-guide context (`kf-agent-guide-context-v1`)
 *                                            for the reader's first record still open: what M4's
 *                                            chat is given when it guides, labelled at the
 *                                            record's level (never below confidential); 404
 *                                            when none is open
 *   GET  /qualification/records/:id          one record as Start Here, for its person, their
 *                                            contact or a reviewer; 404 for anyone else, whether
 *                                            or not the record exists (decision 12)
 *   POST /qualification/records/:id/submit   { requirementKey, evidenceObjectId, note?,
 *                                              idempotencyKey } — the person, or their agent,
 *                                            names evidence; it credits nothing
 *   POST /qualification/records/:id/credit   { credits: [{ submissionId } | { requirementKey,
 *                                              evidenceObjectId | priorCreditId }],
 *                                              idempotencyKey } — a reviewer credits, accepting
 *                                            the work in the same act. When these credits leave no
 *                                            mandatory requirement missing on a record that closes
 *                                            on evidence, the act IS `accept_qualification`: the
 *                                            record closes in the same gesture, with no second
 *                                            approval (RQ-257). An agent's token is refused.
 *   GET  /invitations/:token                 for the signed-in person the owner invited: which
 *                                            organization, and where to go (Start Here). The same
 *                                            404 for every other token or person.
 *   GET  /qualification/records/:id/gestures which institutional gestures on this record the
 *                                            reader may perform now (`withdraw_qualification`,
 *                                            `supersede_qualification` and the records in force
 *                                            that could supersede it); 404 as for the record
 *   GET  /qualification/packs/drafting       whether the reader may draft a pack, every approved
 *                                            pack revision a draft may name as a part (resolved as
 *                                            the act resolves it) and the role ids an authority
 *                                            may name: what a surface needs to run the pack
 *                                            validator itself before it sends anything
 *
 * A gesture is offered only when the reader could perform it: each answer above is the real
 * dispatcher's preflight (`TransactionalActionPreflight`) for that act, as this caller, on the
 * same checks the act meets — role held, attestation, act-grant coverage, visibility, the act's
 * own precondition — plus the state machine's transition from the record's state. A passing
 * preflight confers nothing (KF-SAS-RQ-061): the act is still decided when it is dispatched, by
 * `POST /actions/:actionType`. An agent acting for the person is offered none of them.
 *
 * Every read binds the caller as a principal and reads under that binding; every write is one
 * typed act through the dispatcher, and the database decides it. Nothing here names a role or a
 * title (tests/conformance/no-role-branch.test.ts).
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ActionRejected, type TransactionalActionPreflight } from '@kf/actions';
import { bindPrincipal, PrincipalRefused, withTransaction, type Pool, type Tx } from '@kf/database';
import { createFabricTransactionalPreflight } from '@kf/orchestrator';
import {
  agentGuideContext,
  draftingContext,
  invitationTokenDigest,
  loadRecordEvaluation,
  ownRecords,
  startHere,
  type StartHere,
} from '@kf/qualification';
import { refuseUnidentified } from './actions/auth.js';
import type { ActionRoutesOptions, Caller, IdentifyCaller } from './actions/contracts.js';
import { actionRejectionBody } from './actions/errors.js';

export interface QualificationRoutesOptions {
  readonly pool: Pool;
  readonly execute: ActionRoutesOptions['execute'];
  readonly identify: IdentifyCaller;
  /** The dispatcher's read-only rehearsal; the fabric's own when absent. */
  readonly preflight?: TransactionalActionPreflight;
}

export const START_HERE_LIST_FORMAT = 'kf-start-here-list-v1' as const;
export const RECORD_GESTURES_FORMAT = 'kf-qualification-record-gestures-v1' as const;
export const PACK_DRAFTING_FORMAT = 'kf-qualification-pack-drafting-v1' as const;

/**
 * A reason for a rehearsal only. Preflight checks that a reason is present and says something;
 * nothing rehearsed is recorded, so this text is never stored as anybody's reason.
 */
const REHEARSAL_REASON = 'rehearsal: may this reader perform this act';

/** A record in force that could supersede another: one the reader can read, for the same person. */
export interface SupersedeCandidate {
  readonly recordId: string;
  readonly pack: { readonly title: string; readonly revision: number };
  readonly state: string;
  readonly assignedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/** The reader's records in force, each as Start Here. The caller must already be bound. */
export async function startHerePages(tx: Tx, caller: Caller): Promise<StartHere[]> {
  const pages: StartHere[] = [];
  for (const record of await ownRecords(tx, caller)) {
    const evaluation = await loadRecordEvaluation(tx, record.id);
    if (evaluation !== undefined) pages.push(startHere(evaluation));
  }
  return pages;
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

function idempotencyKeyOf(body: Record<string, unknown>): string | undefined {
  const key = body['idempotencyKey'];
  return typeof key === 'string' && key.length >= 8 && key.length <= 91 ? key : undefined;
}

export function registerQualificationRoutes(
  app: FastifyInstance,
  options: QualificationRoutesOptions,
): void {
  const identify = async (request: { headers: unknown }, reply: FastifyReply) => {
    try {
      return await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (err: unknown) {
      refuseUnidentified(reply, err);
      return undefined;
    }
  };

  const dispatch = async (
    reply: FastifyReply,
    caller: Caller,
    requestId: string,
    actionType: string,
    targetIds: readonly string[],
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ) => {
    try {
      const result = await options.execute({
        actionType,
        actorId: caller.actorId,
        actingRoleId: caller.actingRoleId,
        organizationId: caller.organizationId,
        maxClassification: caller.maxClassification,
        attestation: caller.attestation,
        targetIds,
        idempotencyKey,
        requestId,
        payload: payload as never,
      });
      return reply.code(result.replayed ? 200 : 201).send({
        actionType,
        actionId: result.actionId,
        replayed: result.replayed,
        receipt: result.receipt ?? null,
      });
    } catch (err: unknown) {
      const refusal = actionRejectionBody(err);
      if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
      throw err;
    }
  };

  const preflight = options.preflight ?? createFabricTransactionalPreflight();

  /**
   * Whether the dispatcher's own preflight passes `actionType` for this caller. A refusal is
   * `false`, whichever check refused; anything else is a fault and stays one. Each rehearsal has
   * its own transaction, because a refusal the database raises ends the one it was raised in.
   */
  const rehearse = async (
    caller: Caller,
    requestId: string,
    actionType: string,
    targetIds: readonly string[],
    payload: Record<string, string>,
    reason?: string,
  ): Promise<boolean> => {
    if (caller.agent !== undefined) return false;
    try {
      await withTransaction(options.pool, (tx) =>
        preflight(tx, {
          actionType,
          actorId: caller.actorId,
          actingRoleId: caller.actingRoleId,
          organizationId: caller.organizationId,
          maxClassification: caller.maxClassification,
          attestation: caller.attestation,
          targetIds,
          payload,
          ...(reason === undefined ? {} : { reason }),
          idempotencyKey: `kf-qualification-rehearsal-${randomUUID()}`,
          requestId,
        }),
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof ActionRejected || error instanceof PrincipalRefused) return false;
      throw error;
    }
  };

  app.get<{ Params: { id: string } }>(
    '/qualification/records/:id/gestures',
    async (request, reply) => {
      const caller = await identify(request, reply);
      if (caller === undefined) return reply;
      if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not_found' });
      const recordId = request.params.id;
      const read = await bound(options.pool, caller, async (tx) => {
        const record = await tx.maybeOne<{
          person_id: string;
          state: string;
          withdraw: boolean;
          supersede: boolean;
        }>(
          `select r.person_id::text as person_id, o.lifecycle_state as state,
                  exists (select 1 from registry.state_transition t
                           where t.object_type = o.object_type and t.from_state = o.lifecycle_state
                             and t.action_id = 'withdraw_qualification') as withdraw,
                  exists (select 1 from registry.state_transition t
                           where t.object_type = o.object_type and t.from_state = o.lifecycle_state
                             and t.action_id = 'supersede_qualification') as supersede
             from org.qualification_record r
             join core.object o on o.id = r.id
            where r.id = $1`,
          [recordId],
        );
        if (record === undefined) return undefined;
        const candidates = await tx.query<{
          id: string;
          title: string;
          revision: number;
          state: string;
          assigned_at: Date;
        }>(
          `select r.id::text as id, rev.title, r.pack_revision as revision,
                  o.lifecycle_state as state, r.assigned_at
             from org.qualification_record r
             join core.object o on o.id = r.id
             join org.qualification_pack_revision rev
               on rev.pack_id = r.pack_id and rev.revision = r.pack_revision
            where r.person_id = $1 and r.id <> $2
              and o.lifecycle_state in ('assigned', 'qualified')
            order by r.assigned_at, r.id`,
          [record.person_id, recordId],
        );
        return { record, candidates };
      });
      if (read === undefined) return reply.code(404).send({ error: 'not_found' });
      const requestId = String(request.id);
      const withdraw =
        read.record.withdraw &&
        (await rehearse(
          caller,
          requestId,
          'withdraw_qualification',
          [recordId],
          {},
          REHEARSAL_REASON,
        ));
      const first = read.candidates[0];
      const supersede =
        read.record.supersede &&
        first !== undefined &&
        (await rehearse(
          caller,
          requestId,
          'supersede_qualification',
          [recordId],
          { superseded_by: first.id },
          REHEARSAL_REASON,
        ));
      const candidates: SupersedeCandidate[] = supersede
        ? read.candidates.map((c) => ({
            recordId: c.id,
            pack: { title: c.title, revision: c.revision },
            state: c.state,
            assignedAt: new Date(c.assigned_at).toISOString(),
          }))
        : [];
      return reply.header('cache-control', 'private, no-store').send({
        format: RECORD_GESTURES_FORMAT,
        recordId,
        state: read.record.state,
        withdraw: { available: withdraw },
        supersede: { available: supersede, candidates },
      });
    },
  );

  app.get('/qualification/packs/drafting', async (request, reply) => {
    const caller = await identify(request, reply);
    if (caller === undefined) return reply;
    const context = await bound(options.pool, caller, (tx) =>
      draftingContext(tx, caller.organizationId),
    );
    if (context === undefined) return reply.code(404).send({ error: 'not_found' });
    const available = await rehearse(
      caller,
      String(request.id),
      'draft_qualification_pack',
      [],
      {},
    );
    return reply.header('cache-control', 'private, no-store').send({
      format: PACK_DRAFTING_FORMAT,
      draft: { available },
      parts: context.parts,
      roles: context.roles,
    });
  });

  app.get('/start-here', async (request, reply) => {
    const caller = await identify(request, reply);
    if (caller === undefined) return reply;
    const pages = await bound(options.pool, caller, (tx) => startHerePages(tx, caller));
    if (pages === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('cache-control', 'private, no-store')
      .send({ format: START_HERE_LIST_FORMAT, pages });
  });

  app.get('/start-here/guide', async (request, reply) => {
    const caller = await identify(request, reply);
    if (caller === undefined) return reply;
    const guide = await bound(options.pool, caller, async (tx) => {
      const open = (await startHerePages(tx, caller)).find((page) => page.currency !== 'qualified');
      if (open === undefined) return undefined;
      // The envelope's own label, which agentGuideContext raises to the record's level: never
      // below confidential (ADR 0038 decision 12), so the chat routes it as it routes such a record.
      const envelope = await tx.maybeOne<{ classification: string }>(
        'select classification from core.object where id = $1',
        [open.recordId],
      );
      return agentGuideContext(open, envelope?.classification);
    });
    if (guide === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply.header('cache-control', 'private, no-store').send(guide);
  });

  app.get<{ Params: { id: string } }>('/qualification/records/:id', async (request, reply) => {
    const caller = await identify(request, reply);
    if (caller === undefined) return reply;
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not_found' });
    const page = await bound(options.pool, caller, async (tx) => {
      const evaluation = await loadRecordEvaluation(tx, request.params.id);
      return evaluation === undefined ? undefined : startHere(evaluation);
    });
    if (page === undefined) return reply.code(404).send({ error: 'not_found' });
    return reply.header('cache-control', 'private, no-store').send(page);
  });

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/qualification/records/:id/submit',
    async (request, reply) => {
      const caller = await identify(request, reply);
      if (caller === undefined) return reply;
      const body = request.body ?? {};
      const key = idempotencyKeyOf(body);
      const requirementKey = body['requirementKey'];
      const evidence = body['evidenceObjectId'];
      if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not_found' });
      if (typeof requirementKey !== 'string' || !KEY.test(requirementKey)) {
        return reply.code(400).send({ error: 'invalid_requirement_key' });
      }
      if (typeof evidence !== 'string' || !UUID.test(evidence)) {
        return reply
          .code(400)
          .send({ error: 'invalid_evidence', message: 'evidenceObjectId is a uuid' });
      }
      if (key === undefined) {
        return reply.code(400).send({
          error: 'idempotency_key_required',
          message: 'idempotencyKey, 8 to 91 characters',
        });
      }
      const note = typeof body['note'] === 'string' ? body['note'].slice(0, 2000) : undefined;
      return dispatch(
        reply,
        caller,
        String(request.id),
        'submit_qualification_evidence',
        [request.params.id],
        {
          requirement_key: requirementKey,
          evidence_object_id: evidence,
          ...(note === undefined ? {} : { note }),
        },
        key,
      );
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/qualification/records/:id/credit',
    async (request, reply) => {
      const caller = await identify(request, reply);
      if (caller === undefined) return reply;
      if (caller.agent !== undefined) {
        return reply.code(403).send({
          error: 'agent_cannot_answer',
          message:
            `crediting evidence is a person's judgement; an agent acting for them (${caller.agent}) ` +
            'may explain, assemble and submit, and never credits (ADR 0038 decision 10)',
        });
      }
      const body = request.body ?? {};
      const key = idempotencyKeyOf(body);
      if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not_found' });
      if (key === undefined) {
        return reply.code(400).send({
          error: 'idempotency_key_required',
          message: 'idempotencyKey, 8 to 91 characters',
        });
      }
      const raw = body['credits'];
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
        return reply
          .code(400)
          .send({ error: 'invalid_credits', message: 'credits: 1 to 50 entries' });
      }
      const credits: Record<string, string>[] = [];
      for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          return reply.code(400).send({ error: 'invalid_credits' });
        }
        const e = entry as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [wire, payload] of [
          ['submissionId', 'submission_id'],
          ['evidenceObjectId', 'evidence_object_id'],
          ['priorCreditId', 'prior_credit_id'],
        ] as const) {
          const value = e[wire];
          if (value === undefined) continue;
          if (typeof value !== 'string' || !UUID.test(value)) {
            return reply.code(400).send({ error: 'invalid_credits', message: `${wire} is a uuid` });
          }
          out[payload] = value;
        }
        if (e['requirementKey'] !== undefined) {
          if (typeof e['requirementKey'] !== 'string' || !KEY.test(e['requirementKey'])) {
            return reply.code(400).send({ error: 'invalid_credits', message: 'requirementKey' });
          }
          out['requirement_key'] = e['requirementKey'];
        }
        credits.push(out);
      }
      // Does this gesture complete the record? Then it is the act that closes it. Decided from
      // the record as the reviewer may read it; the database decides again at commit.
      const decision = await bound(options.pool, caller, async (tx) => {
        const evaluation = await loadRecordEvaluation(tx, request.params.id);
        if (evaluation === undefined) return undefined;
        const keys = new Set<string>();
        for (const credit of credits) {
          if (credit['requirement_key'] !== undefined) keys.add(credit['requirement_key']);
          if (credit['submission_id'] !== undefined) {
            const submission = await tx.maybeOne<{ requirement_key: string }>(
              `select requirement_key from org.qualification_evidence_submission
                where id = $1 and record_id = $2`,
              [credit['submission_id'], request.params.id],
            );
            if (submission !== undefined) keys.add(submission.requirement_key);
          }
        }
        const closes =
          evaluation.record.state === 'assigned' &&
          evaluation.record.closing === 'on_evidence' &&
          evaluation.missing.every((missing) => keys.has(missing));
        return { closes };
      });
      if (decision === undefined) return reply.code(404).send({ error: 'not_found' });
      return dispatch(
        reply,
        caller,
        String(request.id),
        decision.closes ? 'accept_qualification' : 'credit_qualification_evidence',
        [request.params.id],
        { credits },
        key,
      );
    },
  );

  app.get<{ Params: { token: string } }>('/invitations/:token', async (request, reply) => {
    const caller = await identify(request, reply);
    if (caller === undefined) return reply;
    const notFound = () => reply.code(404).send({ error: 'not_found' });
    if (!TOKEN.test(request.params.token)) return notFound();
    const invitation = await bound(options.pool, caller, (tx) =>
      tx.maybeOne<{
        id: string;
        organization_id: string;
        qualification_record_id: string | null;
        expires_at: Date;
      }>(
        `select id, organization_id, qualification_record_id, expires_at
           from org.invitation where token_digest = $1`,
        [invitationTokenDigest(request.params.token)],
      ),
    );
    // Row security answers only for the invited person, so any other token or person is the same
    // 404: an invitation link is no credential, and nothing here says whether one exists.
    if (invitation === undefined || invitation === null) return notFound();
    const expired = new Date(invitation.expires_at).getTime() <= Date.now();
    return reply.header('cache-control', 'private, no-store').send({
      format: 'kf-invitation-v1',
      invitationId: invitation.id,
      organizationId: invitation.organization_id,
      recordId: invitation.qualification_record_id,
      expired,
      expiresAt: new Date(invitation.expires_at).toISOString(),
      next: '/start-here',
    });
  });
}
