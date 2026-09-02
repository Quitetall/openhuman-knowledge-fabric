import type { FastifyInstance } from 'fastify';
import { setResolvedAccessContext, withTransaction } from '@kf/database';
import {
  assertPermissionSetInvariant,
  corpusDigest,
  deriveMasterRecordSections,
  enumeratePermittedSet,
  latestMasterRecord,
  masterRecordItems,
  masterRecordWithholdings,
  type MasterRecordManifest,
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
      const result = await withTransaction(options.pool, async (tx) => {
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
        return { result, record };
      });
      // 201 only when THIS action produced the claim. An unchanged corpus reuses the existing
      // record (ADR 0013): the action is recorded, the claim is not new, and saying "created"
      // would tell the caller a record exists that it already had.
      const created =
        !result.result.replayed &&
        result.record !== undefined &&
        String(result.record['recorded_by_action']) === String(result.result.actionId);
      return reply
        .code(created ? 201 : 200)
        .send({ ...result.result, reused: !created, record: result.record });
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
        const manifest = record['manifest'] as Partial<MasterRecordManifest> | null;
        const withdrawn = Array.isArray(manifest?.withdrawn) ? manifest.withdrawn : [];
        const included = Array.isArray(manifest?.included) ? manifest.included : [];
        // Staleness is a CORPUS question (ADR 0013): is the stored claim still the exact set the
        // person is authorized to see? A change in sectioning is not staleness — sections are
        // derived below against the graph as it is now, so a new edge is visible immediately.
        const currentCorpusDigest = corpusDigest(permitted, withdrawn);
        const stale = ((): boolean => {
          try {
            assertPermissionSetInvariant(
              {
                corpusDigest: String(record['corpus_digest']),
                included: included as PermissionMember[],
                withdrawn,
              },
              permitted,
            );
            return false;
          } catch {
            return true;
          }
        })();
        if (stale) {
          return reply.code(409).send({ error: 'master_record_stale', currentCorpusDigest });
        }
        const sections = await deriveMasterRecordSections(tx, {
          personId: identity.actorId,
          included: included as PermissionMember[],
        });
        const relevant = new Set(sections.relevant.map((member) => member.objectId));
        const items = (await masterRecordItems(tx, String(record['id']))).map((item) => ({
          ...item,
          // Derived, not stored. `your_record` is what the relation graph says today.
          section:
            item['item_state'] === 'withdrawn'
              ? 'withdrawn'
              : relevant.has(String(item['object_id']))
                ? 'your_record'
                : 'org_view',
        }));
        const withholdings = await masterRecordWithholdings(tx, String(record['id']));
        return reply.send({
          ...record,
          stale,
          currentCorpusDigest,
          sections: {
            relevantMemberCount: sections.relevantMemberCount,
            organizationViewMemberCount: sections.organizationViewMemberCount,
            relevanceFanoutByAnchorType: sections.relevanceFanoutByAnchorType,
            relevanceFanoutByPropagationClass: sections.relevanceFanoutByPropagationClass,
          },
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
