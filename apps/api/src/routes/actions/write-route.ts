import type { FastifyInstance, FastifyReply } from 'fastify';
import { satisfiesStepUp, type StepUpPolicy, type TokenVerifier } from '@kf/authorization';
import type {
  ActionRoutesOptions,
  ActionRequestBody,
  Caller,
  IdentifyCaller,
} from './contracts.js';
import { parseEffectiveAt } from './effective-at.js';
import { actionRejectionBody } from './errors.js';
import { unidentified } from './auth.js';

interface ActionPostRouteOptions {
  readonly execute: ActionRoutesOptions['execute'];
  readonly identify: IdentifyCaller;
  readonly stepUp: Readonly<Record<string, StepUpPolicy>>;
  readonly verifier: TokenVerifier | undefined;
}

export function registerUnavailableActionRoute(app: FastifyInstance): void {
  // Fail at startup, not at the first request. A deployment that would have trusted
  // client-supplied identity should never reach the point of serving traffic.
  app.log.warn('action routes are disabled: no verified identity provider is configured');
  app.post('/actions/:actionType', async (_request, reply) =>
    reply.code(503).send({
      error: 'no_identity_provider',
      message: 'This deployment has no verified identity provider; actions are refused.',
    }),
  );
}

export function registerActionPostRoute(
  app: FastifyInstance,
  options: ActionPostRouteOptions,
): void {
  app.post<{
    Params: { actionType: string };
    Body: ActionRequestBody;
  }>('/actions/:actionType', async (request, reply) => {
    let caller: Caller;
    try {
      caller = await options.identify({ headers: request.headers as Record<string, unknown> });
    } catch (err: unknown) {
      return reply.code(401).send(unidentified(err));
    }

    const body = request.body ?? {};
    if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8) {
      return reply.code(400).send({
        error: 'idempotency_key_required',
        message: 'idempotencyKey must be supplied by the caller and be at least 8 characters',
      });
    }
    const effectiveAt = parseEffectiveAt(body.effectiveAt);
    if (body.effectiveAt !== undefined && effectiveAt === undefined) {
      return reply.code(400).send({
        error: 'invalid_effective_at',
        message: 'effectiveAt must be a canonical four-digit-year RFC 3339 millisecond instant',
      });
    }

    const stepUpReply = requireStepUp(caller, request.params.actionType, options);
    if (stepUpReply !== undefined) return stepUpReply(reply);

    try {
      const result = await options.execute({
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
        ...(effectiveAt === undefined ? {} : { effectiveAt }),
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (err: unknown) {
      const refusal = actionRejectionBody(err);
      if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
      request.log.error({ err }, 'action failed');
      return reply.code(500).send({ error: 'internal_error', requestId: request.id });
    }
  });
}

function requireStepUp(
  caller: Caller,
  actionType: string,
  options: ActionPostRouteOptions,
): ((reply: FastifyReply) => unknown) | undefined {
  const policy = options.verifier === undefined ? undefined : options.stepUp[actionType];
  if (policy === undefined) return undefined;
  const outcome = satisfiesStepUp(caller.authentication, policy);
  if (outcome.satisfied) return undefined;
  return (reply) =>
    reply
      .code(401)
      .header(
        'www-authenticate',
        `Bearer error="insufficient_user_authentication", max_age=${policy.maxAgeSeconds ?? 0}`,
      )
      .send({
        error: 'step_up_required',
        message: outcome.detail ?? 'this action requires a stronger authentication',
        detail: { failure: outcome.failure, actionType },
      });
}
