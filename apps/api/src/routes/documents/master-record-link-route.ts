import type { FastifyInstance } from 'fastify';
import { digest, digestBytes } from '@kf/canonicalization';
import { setAccessContext, withTransaction } from '@kf/database';
import {
  assertPermissionSetInvariant,
  enumeratePermittedSet,
  masterRecordItems,
  type PermissionMember,
  verifyMasterRecordLinkToken,
} from '@kf/documents';
import type { DocumentRoutesOptions } from './contracts.js';

/** Serve one signed capability without introducing a browser/management surface. */
export function registerMasterRecordLinkRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get<{ Params: { token: string } }>('/master-record-links/:token', async (request, reply) => {
    const secret = options.masterRecordLinkSecret;
    if (secret === undefined) return reply.code(503).send({ error: 'link_delivery_unconfigured' });
    const claims = verifyMasterRecordLinkToken(request.params.token, secret);
    if (claims === undefined) return reply.code(404).send({ error: 'link_not_found' });
    const suppliedDigest = digestBytes(Buffer.from(request.params.token, 'utf8'));

    // Keep reply handling outside transaction. Fastify may finish an injected response as soon
    // as reply.send is called, while the transaction still has to commit its append-only access
    // evidence. Returning a value and sending after withTransaction makes response completion
    // happen after commit, so a caller never observes a delivered response before its audit row.
    const result = await withTransaction(options.pool, async (tx) => {
      const link = await tx.maybeOne<{
        link_id: string;
        master_record_id: string;
        organization_id: string;
        effective_classification: string;
        scope: Record<string, unknown>;
        issued_at: Date;
        expires_at: Date;
        revoked: boolean;
        record_digest: string;
      }>(
        `select link_id, master_record_id, organization_id, effective_classification, scope,
                issued_at, expires_at, revoked, record_digest
           from content.resolve_master_record_link($1)`,
        [suppliedDigest],
      );
      if (
        link === undefined ||
        link.link_id !== claims.linkId ||
        link.master_record_id !== claims.masterRecordId ||
        digest(link.scope) !== digest(claims.scope)
      ) {
        return { statusCode: 404, body: { error: 'link_not_found' } };
      }

      await setAccessContext(tx, {
        organizationId: link.organization_id,
        maxClassification: link.effective_classification,
      });
      const log = async (result: 'expired' | 'revoked' | 'invalid' | 'stale' | 'served') => {
        await tx.query(
          `insert into content.master_record_link_access
             (link_id, result, record_digest, detail)
           values ($1,$2,$3,$4::jsonb)`,
          [link.link_id, result, link.record_digest, JSON.stringify({ scope: link.scope })],
        );
      };
      if (link.revoked) {
        await log('revoked');
        return { statusCode: 410, body: { error: 'link_revoked' } };
      }
      if (Date.now() >= link.expires_at.getTime() || Date.now() >= Date.parse(claims.expiresAt)) {
        await log('expired');
        return { statusCode: 410, body: { error: 'link_expired' } };
      }
      if (link.scope['kind'] !== 'master_record' && link.scope['kind'] !== 'derived_subset') {
        await log('invalid');
        return { statusCode: 404, body: { error: 'link_not_found' } };
      }

      const record = await tx.maybeOne<Record<string, unknown>>(
        `select id, person_id, organization_id, compilation_run_id, effective_classification,
                permission_digest, record_digest, manifest, compiled_at, recorded_at,
                recorded_by, recorded_by_action
           from content.master_record where id = $1`,
        [link.master_record_id],
      );
      if (record === undefined || record['record_digest'] !== link.record_digest) {
        await log('invalid');
        return { statusCode: 404, body: { error: 'link_not_found' } };
      }
      const permitted = await enumeratePermittedSet(
        tx,
        String(record['person_id']),
        link.organization_id,
      );
      try {
        const manifest = record['manifest'];
        if (typeof manifest !== 'object' || manifest === null) throw new Error('manifest missing');
        const included = (manifest as { included?: unknown }).included;
        if (!Array.isArray(included)) throw new Error('manifest members missing');
        assertPermissionSetInvariant(
          {
            permissionDigest: String(record['permission_digest']),
            included: included as PermissionMember[],
          },
          permitted,
        );
      } catch {
        await log('stale');
        return { statusCode: 409, body: { error: 'master_record_stale' } };
      }
      const items = await masterRecordItems(tx, link.master_record_id);
      if (link.scope['kind'] === 'derived_subset') {
        const subjectId = link.scope['subjectId'];
        const recipientId = link.scope['recipientId'];
        const objectIds = link.scope['objectIds'];
        if (
          typeof subjectId !== 'string' ||
          typeof recipientId !== 'string' ||
          !Array.isArray(objectIds) ||
          objectIds.length === 0 ||
          objectIds.some((objectId) => typeof objectId !== 'string') ||
          new Set(objectIds).size !== objectIds.length ||
          subjectId !== String(record['person_id'])
        ) {
          await log('invalid');
          return { statusCode: 404, body: { error: 'link_not_found' } };
        }
        const selected = new Set(objectIds);
        const subsetItems = items.filter((item) => selected.has(String(item['object_id'])));
        if (subsetItems.length !== objectIds.length) {
          await log('invalid');
          return { statusCode: 404, body: { error: 'link_not_found' } };
        }
        await log('served');
        return {
          statusCode: 200,
          body: {
            subset: true,
            scope: link.scope,
            sourceRecordId: record['id'],
            sourceRecordDigest: record['record_digest'],
            record: {
              id: record['id'],
              person_id: record['person_id'],
              organization_id: record['organization_id'],
              effective_classification: record['effective_classification'],
              permission_digest: record['permission_digest'],
              record_digest: record['record_digest'],
              compiled_at: record['compiled_at'],
              recorded_at: record['recorded_at'],
              recorded_by: record['recorded_by'],
              recorded_by_action: record['recorded_by_action'],
            },
            items: subsetItems,
          },
        };
      }
      await log('served');
      return {
        statusCode: 200,
        body: { record, items },
      };
    });
    return reply.code(result.statusCode).send(result.body);
  });
}
