/**
 * The action endpoint. One route, every controlled change.
 *
 * There is no `PATCH /work-orders/:id`. There never will be, and the shape of this file is
 * the reason: a record that can be changed by field assignment cannot answer "who moved it,
 * under what authority, and why". Every write in the system is
 *
 *   POST /actions/:actionType   { targetIds, payload, reason, idempotencyKey }
 *
 * and the dispatcher decides whether it is allowed. An endpoint that bypassed it would
 * bypass the audit chain, the state machine and the invariants at once.
 *
 * Read routes are separate and plural, because reading is not the inverse of writing here:
 * a work order is written by an action and read as a projection over several tables.
 */

import type { FastifyInstance } from 'fastify';
import { ActionRejected, DEFAULT_REASON_REQUIRED, type ActionRequest } from '@kf/actions';
import { withTransaction, type Pool } from '@kf/database';
import {
  DEFAULT_STEP_UP,
  IdentityRejected,
  type AuthenticationEvent,
  resolveCaller,
  satisfiesStepUp,
  type StepUpPolicy,
  type TokenVerifier,
} from '@kf/authorization';
import { projectProgress } from '@kf/work-control';

/**
 * Who is calling and what they may see.
 *
 * Two paths, and only one of them is real.
 *
 * With an identity provider configured, a bearer token is verified against the issuer's keys,
 * its subject is mapped to a person, and the acting role is checked against a live role
 * assignment. Role claims in the token are never read — the provider says WHO, the database
 * says what they may do.
 *
 * Without one, identity comes from headers, and that path exists only where the deployment has
 * said twice that it is a development one. A header-trusting auth path reaching production is
 * a total authentication bypass, and "we'll remember to change it" is not a control.
 */
export interface Caller {
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly organizationId: string;
  readonly maxClassification: string;
  /**
   * How and when this caller authenticated. Empty on the header path, which is why step-up is
   * not applied there: every policy would fail, and the development path would be unusable.
   */
  readonly authentication: AuthenticationEvent;
}

export class CallerRejected extends Error {}

function callerFrom(headers: Record<string, unknown>): Caller {
  const get = (name: string): string => {
    const v = headers[name];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new CallerRejected(`${name} is required`);
    }
    return v;
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
function unidentified(err: unknown): { error: string; message: string } {
  if (err instanceof IdentityRejected) {
    return { error: err.failure, message: err.message };
  }
  return { error: 'caller_unidentified', message: (err as Error).message };
}

/** How each refusal maps to a status code. */
const STATUS: Record<string, number> = {
  unknown_action: 404,
  actor_not_authorized: 403,
  role_not_held: 403,
  separation_of_duty: 403,
  object_not_visible: 404,
  version_conflict: 409,
  illegal_transition: 409,
  precondition_failed: 422,
  reason_required: 400,
};

/**
 * Recognise a named invariant refused by a database trigger.
 *
 * The triggers raise `check_violation` with a message beginning with the rule id, so the rule
 * is identified from the raised text rather than from which statement happened to fail. Only
 * `check_violation` qualifies: a message that merely mentions a rule id is not a refusal by
 * that rule.
 */
function ruleViolation(err: unknown): { id: string; message: string } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: string; message?: string };
  if (e.code !== '23514' || typeof e.message !== 'string') return undefined;
  const match = /^(KF-[A-Z]+-\d+):/.exec(e.message);
  return match === null ? undefined : { id: match[1]!, message: e.message };
}

export interface ActionRoutesOptions {
  readonly pool: Pool;
  /**
   * Verifies bearer tokens. When present it is the ONLY way to become a caller; headers are
   * ignored entirely rather than used as a fallback, because a fallback is a bypass that
   * activates exactly when the provider is unreachable.
   */
  readonly verifier?: TokenVerifier;
  readonly execute: (request: ActionRequest) => Promise<{
    actionId: string;
    replayed: boolean;
    objectIds: readonly string[];
    auditDigest: string;
  }>;
  /** True only in development. Header-based identity is refused otherwise. */
  readonly trustHeaders: boolean;
  /**
   * Actions that require a recent or strong authentication, keyed by action type.
   *
   * Only meaningful with a verifier: header identity carries no authentication event, so
   * every policy would fail. That is the correct direction — but it would also make the
   * development path unusable, so step-up is not applied when there is no verifier at all.
   */
  readonly stepUp?: Readonly<Record<string, StepUpPolicy>>;
}

export async function registerActionRoutes(
  app: FastifyInstance,
  options: ActionRoutesOptions,
): Promise<void> {
  const { pool, execute, verifier } = options;
  const stepUp = options.stepUp ?? DEFAULT_STEP_UP;

  /**
   * The caller, from a token or from headers — never from both.
   *
   * Which one is decided at startup, not per request. A route that accepted a token when it
   * had one and headers otherwise would let anybody who could omit a header downgrade the
   * whole authentication scheme.
   */
  async function identify(request: { headers: Record<string, unknown> }): Promise<Caller> {
    if (verifier === undefined) return callerFrom(request.headers);

    const authorization = request.headers['authorization'];
    const token =
      typeof authorization === 'string' && /^bearer /i.test(authorization)
        ? authorization.slice(7).trim()
        : '';

    const header = (name: string): string => {
      const v = request.headers[name];
      return typeof v === 'string' ? v : '';
    };
    // The role, organization and clearance are still stated by the caller — and every one of
    // them is checked against the database. Stating a role you do not hold is refused; a
    // clearance you do not have narrows what row-level security shows you rather than
    // widening it.
    return resolveCaller(pool, verifier, {
      token,
      actingRoleId: header('x-kf-acting-role'),
      organizationId: header('x-kf-organization'),
      maxClassification: header('x-kf-classification') || 'internal',
    });
  }

  if (verifier === undefined && !options.trustHeaders) {
    // Fail at startup, not at the first request. A deployment that would have trusted
    // client-supplied identity should never reach the point of serving traffic.
    app.log.warn('action routes are disabled: no verified identity provider is configured');
    app.post('/actions/:actionType', async (_request, reply) =>
      reply.code(503).send({
        error: 'no_identity_provider',
        message: 'This deployment has no verified identity provider; actions are refused.',
      }),
    );
    return;
  }

  app.post<{
    Params: { actionType: string };
    Body: {
      targetIds?: string[];
      payload?: Record<string, never>;
      reason?: string;
      idempotencyKey?: string;
      expectedVersion?: number;
      effectiveAt?: string;
    };
  }>('/actions/:actionType', async (request, reply) => {
    let caller: Caller;
    try {
      caller = await identify({ headers: request.headers as Record<string, unknown> });
    } catch (err: unknown) {
      return reply.code(401).send(unidentified(err));
    }

    const body = request.body ?? {};
    if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8) {
      // Required, not generated. A key the server invents is not stable across the caller's
      // retries, which is the only thing it is for.
      return reply.code(400).send({
        error: 'idempotency_key_required',
        message: 'idempotencyKey must be supplied by the caller and be at least 8 characters',
      });
    }

    // Step-up, after identity and before anything is attempted. An action that moves money
    // or withdraws a control should not rest on a session somebody walked away from.
    const policy = verifier === undefined ? undefined : stepUp[request.params.actionType];
    if (policy !== undefined) {
      const outcome = satisfiesStepUp(caller.authentication, policy);
      if (!outcome.satisfied) {
        // 401 with the standard challenge, not 403: the caller can fix this by
        // re-authenticating, and `insufficient_user_authentication` is what tells their
        // client to send them back to the provider with max_age set.
        return reply
          .code(401)
          .header(
            'www-authenticate',
            `Bearer error="insufficient_user_authentication", max_age=${policy.maxAgeSeconds ?? 0}`,
          )
          .send({
            error: 'step_up_required',
            message: outcome.detail ?? 'this action requires a stronger authentication',
            detail: { failure: outcome.failure, actionType: request.params.actionType },
          });
      }
    }

    try {
      const result = await execute({
        actionType: request.params.actionType,
        actorId: caller.actorId,
        actingRoleId: caller.actingRoleId,
        organizationId: caller.organizationId,
        maxClassification: caller.maxClassification,
        targetIds: body.targetIds ?? [],
        idempotencyKey: body.idempotencyKey,
        requestId: String(request.id),
        ...(body.payload !== undefined ? { payload: body.payload } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
        ...(body.effectiveAt !== undefined ? { effectiveAt: new Date(body.effectiveAt) } : {}),
      });
      // 200 rather than 201 on a replay: nothing was created this time, and a caller
      // retrying after a timeout should be able to tell.
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (err: unknown) {
      if (err instanceof ActionRejected) {
        return reply.code(STATUS[err.failure] ?? 422).send({
          error: err.failure,
          message: err.message,
          detail: err.detail,
        });
      }
      // A financial invariant refused by its TRIGGER rather than by its precondition. Both
      // layers guard the same rules on purpose, and under concurrency the database is the
      // one that wins — two acceptances can each pass the application check and only one
      // survive the row lock. That is the control working, so it must reach the caller as a
      // refusal they can act on, not as a 500 they retry forever.
      const rule = ruleViolation(err);
      if (rule !== undefined) {
        return reply.code(422).send({
          error: 'precondition_failed',
          message: rule.message,
          detail: { rule: rule.id, enforcedBy: 'database' },
        });
      }

      // Anything else is a fault, not a refusal. The message is logged in full and NOT
      // returned: a database error text can name tables, columns and values.
      request.log.error({ err }, 'action failed');
      return reply.code(500).send({ error: 'internal_error', requestId: request.id });
    }
  });

  // ── reads ─────────────────────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    let caller: Caller;
    try {
      caller = await identify({ headers: request.headers as Record<string, unknown> });
    } catch (err: unknown) {
      return reply.code(401).send(unidentified(err));
    }

    return withTransaction(pool, async (tx) => {
      // Scope FIRST, then read. Row-level security does the filtering; skipping this would
      // return nothing rather than everything, but relying on that would be relying on a
      // failure mode.
      await tx.query('select core.set_access_context($1, $2)', [
        caller.organizationId,
        caller.maxClassification,
      ]);

      const project = await tx.maybeOne<Record<string, unknown>>(
        `select o.id, o.enterprise_id, o.title, o.lifecycle_state, o.row_version,
                p.project_code, p.objective, p.sponsor_id, p.started_on, p.target_completion
           from core.object o
           join work.initiative_project p on p.id = o.id
          where o.id = $1`,
        [request.params.id],
      );
      if (project === undefined) return reply.code(404).send({ error: 'not_found' });

      const packages = await tx.query<Record<string, unknown>>(
        `select o.id, o.title, o.lifecycle_state, wp.sequence_no, wp.acceptance_criterion
           from work.work_package wp
           join core.object o on o.id = wp.id
          where wp.project_id = $1 order by wp.sequence_no`,
        [request.params.id],
      );

      return reply.send({
        ...project,
        packages,
        // KF-PROJ-001. Computed on read, never stored: a stored percentage is one more
        // number that can disagree with the records it summarises.
        progress: await projectProgress(tx, request.params.id),
      });
    });
  });

  /**
   * What can be done to this record next, according to the ontology.
   *
   * The interface asks rather than knowing. A UI that hard-coded which buttons to show for
   * which state would be a second copy of the state machine, and the copy is the one that
   * goes stale — leaving buttons that always fail, or worse, hiding a transition that is
   * perfectly legal. This is the registry the dispatcher itself reads.
   *
   * It is a hint, never an authorization: an action listed here can still be refused for
   * separation of duty, a precondition or a financial ceiling, because those depend on facts
   * this endpoint does not evaluate.
   */
  app.get<{ Params: { id: string } }>('/objects/:id/available-actions', async (request, reply) => {
    let caller: Caller;
    try {
      caller = await identify({ headers: request.headers as Record<string, unknown> });
    } catch (err: unknown) {
      return reply.code(401).send(unidentified(err));
    }

    return withTransaction(pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        caller.organizationId,
        caller.maxClassification,
      ]);
      const object = await tx.maybeOne<{ object_type: string; lifecycle_state: string }>(
        'select object_type, lifecycle_state from core.object where id = $1',
        [request.params.id],
      );
      if (object === undefined) return reply.code(404).send({ error: 'not_found' });

      const transitions = await tx.query<{ action_id: string; to_state: string }>(
        `select t.action_id, t.to_state
           from registry.state_transition t
          where t.object_type = $1 and t.from_state = $2
          order by t.action_id, t.to_state`,
        [object.object_type, object.lifecycle_state],
      );

      const byAction = new Map<string, string[]>();
      for (const t of transitions) {
        byAction.set(t.action_id, [...(byAction.get(t.action_id) ?? []), t.to_state]);
      }

      return reply.send({
        objectId: request.params.id,
        objectType: object.object_type,
        state: object.lifecycle_state,
        actions: [...byAction.entries()].map(([actionType, toStates]) => ({
          actionType,
          toStates,
          // More than one destination means the caller must choose; the dispatcher refuses
          // to guess which branch of a lifecycle to take.
          requiresChoice: toStates.length > 1,
          // From the dispatcher's own list, not a copy. An interface holding its own would
          // stop asking for a reason on an action that started requiring one, and the user
          // would meet a 400 with no field to fill in.
          reasonRequired: DEFAULT_REASON_REQUIRED.includes(actionType),
        })),
      });
    });
  });

  /** The audit trail for one object — what an auditor asks for first. */
  app.get<{ Params: { id: string } }>('/objects/:id/history', async (request, reply) => {
    let caller: Caller;
    try {
      caller = await identify({ headers: request.headers as Record<string, unknown> });
    } catch (err: unknown) {
      return reply.code(401).send(unidentified(err));
    }

    return withTransaction(pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [
        caller.organizationId,
        caller.maxClassification,
      ]);
      const visible = await tx.maybeOne<{ id: string }>(
        'select id from core.object where id = $1',
        [request.params.id],
      );
      if (visible === undefined) return reply.code(404).send({ error: 'not_found' });

      const events = await tx.query<Record<string, unknown>>(
        `select e.seq, e.action_type, e.actor_id, e.acting_role_id, e.recorded_at,
                e.effective_at, e.reason, e.digest
           from core.audit_event e
          where e.object_id = $1 or $1 = any(
                  select unnest(a.target_ids) from core.action a where a.id = e.action_id)
          order by e.seq`,
        [request.params.id],
      );
      return reply.send({ objectId: request.params.id, events });
    });
  });
}
