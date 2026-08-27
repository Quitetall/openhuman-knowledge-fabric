import type { FastifyInstance } from 'fastify';
import { setResolvedAccessContext, withTransaction } from '@kf/database';
import {
  assertPermissionSetInvariant,
  enumeratePermittedSet,
  latestMasterRecord,
  masterRecordItems,
  masterRecordWithholdings,
  permissionDigest,
  type PermissionMember,
} from '@kf/documents';
import { unidentified } from '../actions.js';
import { actionRejectionBody } from '../actions/errors.js';
import type { DocumentRoutesOptions } from './contracts.js';

/**
 * API-only master-record read surface. It exposes an already-compiled claim plus its current
 * digest; it does not render HTML or provide management/browser behavior (OW-WAR-0056 scope).
 */
export function registerMasterRecordRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.post<{
    Body: { readonly idempotencyKey?: unknown; readonly reason?: unknown };
  }>('/master-record/compile', async (request, reply) => {
    let identity;
    try {
      identity = await options.identify({
        headers: request.headers as Record<string, unknown>,
      });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }
    const body = request.body ?? {};
    if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8) {
      return reply.code(400).send({
        error: 'idempotency_key_required',
        message: 'idempotencyKey must be supplied and be at least 8 characters',
      });
    }
    const idempotencyKey = body.idempotencyKey;
    try {
      return withTransaction(options.pool, async (tx) => {
        const result = await options.executeInTransaction(tx, {
          actionType: 'compile_master_record',
          actorId: identity.actorId,
          actingRoleId: identity.actingRoleId,
          organizationId: identity.organizationId,
          maxClassification: identity.maxClassification,
          targetIds: [identity.actorId],
          idempotencyKey,
          requestId: String(request.id),
          ...(typeof body.reason === 'string' && body.reason.trim() !== ''
            ? { reason: body.reason }
            : {}),
        });
        const record = await latestMasterRecord(tx, identity.actorId, identity.organizationId);
        return reply.code(result.replayed ? 200 : 201).send({ ...result, record });
      });
    } catch (error: unknown) {
      const refusal = actionRejectionBody(error);
      if (refusal !== undefined) return reply.code(refusal.status).send(refusal.body);
      request.log.error({ err: error }, 'master record compilation failed');
      return reply.code(500).send({ error: 'internal_error', requestId: request.id });
    }
  });

  app.get('/master-record', async (request, reply) => {
    let identity;
    try {
      identity = await options.identify({
        headers: request.headers as Record<string, unknown>,
      });
    } catch (error: unknown) {
      return reply.code(401).send(unidentified(error));
    }

    try {
      return await withTransaction(options.pool, async (tx) => {
        await setResolvedAccessContext(tx, {
          subjectId: identity.actorId,
          assignmentId: identity.actingRoleId,
          organizationId: identity.organizationId,
          requestedClassification: identity.maxClassification,
        });
        const record = await latestMasterRecord(tx, identity.actorId, identity.organizationId);
        if (record === undefined) return reply.code(404).send({ error: 'master_record_not_found' });

        const permitted = await enumeratePermittedSet(
          tx,
          identity.actorId,
          identity.organizationId,
        );
        const manifest = record['manifest'];
        const currentPermissionDigest = permissionDigest(permitted);
        let stale = true;
        if (
          typeof manifest === 'object' &&
          manifest !== null &&
          'permissionDigest' in manifest &&
          'included' in manifest &&
          Array.isArray((manifest as { included?: unknown }).included)
        ) {
          const candidate = manifest as {
            permissionDigest: unknown;
            included: unknown[];
          };
          try {
            assertPermissionSetInvariant(
              {
                permissionDigest: String(candidate.permissionDigest),
                included: candidate.included as PermissionMember[],
              },
              permitted,
            );
            stale = false;
          } catch {
            stale = true;
          }
        }
        if (stale) {
          return reply.code(409).send({ error: 'master_record_stale', currentPermissionDigest });
        }
        const items = await masterRecordItems(tx, String(record['id']));
        const withholdings = await masterRecordWithholdings(tx, String(record['id']));
        return reply.send({
          ...record,
          stale,
          currentPermissionDigest,
          items,
          withholdings,
        });
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code ?? '')
          : '';
      if (code === '42501' || code === 'P0001' || /classification|clearance/i.test(message)) {
        return reply.code(403).send({ error: 'classification_not_granted' });
      }
      throw error;
    }
  });
}
