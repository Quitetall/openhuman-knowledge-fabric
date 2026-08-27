import type { FastifyInstance } from 'fastify';
import { digestBytes } from '@kf/canonicalization';
import { setAccessContext, withTransaction } from '@kf/database';
import {
  assertPermissionDigest,
  enumeratePermittedSet,
  masterRecordItems,
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

    return withTransaction(options.pool, async (tx) => {
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
        link.master_record_id !== claims.masterRecordId
      ) {
        return reply.code(404).send({ error: 'link_not_found' });
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
        return reply.code(410).send({ error: 'link_revoked' });
      }
      if (Date.now() >= link.expires_at.getTime() || Date.now() >= Date.parse(claims.expiresAt)) {
        await log('expired');
        return reply.code(410).send({ error: 'link_expired' });
      }
      if (link.scope['kind'] !== 'master_record') {
        await log('invalid');
        return reply.code(404).send({ error: 'link_not_found' });
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
        return reply.code(404).send({ error: 'link_not_found' });
      }
      const permitted = await enumeratePermittedSet(
        tx,
        String(record['person_id']),
        link.organization_id,
      );
      try {
        assertPermissionDigest(
          { permissionDigest: String(record['permission_digest']) },
          permitted,
        );
      } catch {
        await log('stale');
        return reply.code(409).send({ error: 'master_record_stale' });
      }
      await log('served');
      return reply.send({ record, items: await masterRecordItems(tx, link.master_record_id) });
    });
  });
}
