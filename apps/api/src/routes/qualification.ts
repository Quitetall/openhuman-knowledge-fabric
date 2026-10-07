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
 *
 * Every read binds the caller as a principal and reads under that binding; every write is one
 * typed act through the dispatcher, and the database decides it. Nothing here names a role or a
 * title (tests/conformance/no-role-branch.test.ts).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { bindPrincipal, PrincipalRefused, withTransaction, type Pool, type Tx } from '@kf/database';
import {
  agentGuideContext,
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
}

export const START_HERE_LIST_FORMAT = 'kf-start-here-list-v1' as const;

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
