import type { FastifyInstance } from 'fastify';
import { ActionRejected } from '@kf/actions';
import { IdentityRejected } from '@kf/authorization';
import { setAccessContext, withTransaction } from '@kf/database';
import { actionForMetricEventAppend, metricEventActionIdempotencyKey } from '@kf/integration';
import { MetricEventJournal, MlRegistryRejected } from '@kf/ml-registry';
import { CallerRejected, unidentified } from '../../actions.js';
import type { MlRoutesOptions } from '../../ml.js';
import { MlSchemaUnavailable, requireMlSchema } from '../../../schema-contract.js';
import type { MetricEventBody } from '../contracts.js';
import { ProjectionError, refSelect } from '../projection.js';
import { OPAQUE_REFERENCE_TOKEN, parseMetricEventBody, postgresFailure } from '../validation.js';
import {
  decodeIngestDefinitionRow,
  decodeIngestRunRow,
  decodeStoredMetricEvent,
} from './decoders.js';
import type {
  IngestDefinitionRow,
  IngestReceiptRow,
  IngestRunRow,
  StoredMetricResult,
} from './types.js';

export function registerMetricEventRoute(app: FastifyInstance, options: MlRoutesOptions): void {
  app.post<{
    Params: {
      authorityId: string;
      revisionId: string;
      metricAuthorityId: string;
      metricRevisionId: string;
    };
    Body: MetricEventBody;
  }>(
    '/ml/runs/:authorityId/revisions/:revisionId/metrics/:metricAuthorityId/revisions/:metricRevisionId/events',
    async (request, reply) => {
      let caller;
      try {
        caller = await options.identify({
          headers: request.headers as Record<string, unknown>,
        });
      } catch (error: unknown) {
        if (error instanceof CallerRejected || error instanceof IdentityRejected) {
          return reply.code(401).send(unidentified(error));
        }
        request.log.error({ err: error }, 'ML metric caller identification failed');
        return reply.code(500).send({ error: 'internal_error', requestId: request.id });
      }

      if (
        !OPAQUE_REFERENCE_TOKEN.test(request.params.authorityId) ||
        !OPAQUE_REFERENCE_TOKEN.test(request.params.revisionId) ||
        !OPAQUE_REFERENCE_TOKEN.test(request.params.metricAuthorityId) ||
        !OPAQUE_REFERENCE_TOKEN.test(request.params.metricRevisionId)
      ) {
        return reply.code(400).send({
          error: 'invalid_metric_reference',
          message: 'run and metric authority revisions must be opaque registry identifiers',
        });
      }

      const body = parseMetricEventBody(request.body);
      if (body === undefined) {
        return reply.code(400).send({
          error: 'invalid_metric_event',
          message:
            'metric event has an invalid idempotency key, sequence, timestamp, or typed value',
        });
      }

      try {
        const result = await withTransaction(options.pool, async (tx) => {
          await setAccessContext(tx, {
            organizationId: caller.organizationId,
            maxClassification: caller.maxClassification,
          });
          await requireMlSchema(tx);

          const runRow = await tx.maybeOne<IngestRunRow>(
            `/* ml.ingest-run */
             select lineage.id::text as lineage_id,
                    run_ref.organization_id::text as run_organization_id,
                    ${refSelect('run_ref', 'run')}
               from ml.run_lineage lineage
               join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
              where run_ref.authority_id = $1
                and run_ref.revision_id = $2
                and run_ref.aggregate_kind = 'run'`,
            [request.params.authorityId, request.params.revisionId],
          );
          if (runRow === undefined) return undefined;

          const definitionRow = await tx.maybeOne<IngestDefinitionRow>(
            `/* ml.ingest-definition */
             select definition.id::text as definition_id,
                    definition_ref.organization_id::text as definition_organization_id,
                    definition.metric_id,
                    definition.value_kind,
                    definition.unit_id,
                    definition.allowed_enum_ids,
                    ${refSelect('definition_ref', 'definition')}
               from ml.metric_definition definition
               join ml.aggregate_reference definition_ref
                 on definition_ref.id = definition.definition_ref_id
              where definition_ref.authority_id = $1
                and definition_ref.revision_id = $2
                and definition_ref.aggregate_kind = 'metric_definition'`,
            [request.params.metricAuthorityId, request.params.metricRevisionId],
          );
          if (definitionRow === undefined) return undefined;

          const run = decodeIngestRunRow(
            runRow,
            caller.organizationId,
            request.params.authorityId,
            request.params.revisionId,
          );
          const decodedDefinition = decodeIngestDefinitionRow(
            definitionRow,
            caller.organizationId,
            request.params.metricAuthorityId,
            request.params.metricRevisionId,
          );
          const definition = decodedDefinition.definition;
          const candidate = new MetricEventJournal().append(definition, {
            idempotencyKey: body.idempotencyKey,
            run: run.reference,
            sequence: body.sequence,
            recordedAt: body.recordedAt,
            value: body.value,
          });

          const lineageId = run.lineageId;
          const definitionId = decodedDefinition.definitionId;
          const intent = actionForMetricEventAppend({
            organizationId: caller.organizationId,
            runLineageId: lineageId,
            metricDefinitionId: definitionId,
            event: candidate,
          });
          const action = await options.executeInTransaction(tx, {
            actionType: intent.actionType,
            actorId: caller.actorId,
            actingRoleId: caller.actingRoleId,
            targetIds: [intent.targetId],
            payload: intent.parameters,
            idempotencyKey: metricEventActionIdempotencyKey(candidate.eventDigest),
            organizationId: caller.organizationId,
            maxClassification: caller.maxClassification,
            requestId: request.id,
          });

          const storedRow = await tx.maybeOne<IngestReceiptRow>(
            `/* ml.ingest-receipt */
             select event.id::text as id,
                    event.sequence_no::text as sequence_no,
                    event.recorded_at,
                    event.status,
                    event.event_sha256
               from ml.metric_event event
              where event.run_lineage_id = $1::uuid
                and event.metric_definition_id = $2::uuid
                and event.idempotency_key = $3
                and event.event_sha256 = $4`,
            [lineageId, definitionId, candidate.idempotencyKey, candidate.eventDigest],
          );
          if (storedRow === undefined) {
            throw new ProjectionError('typed metric action committed no matching event receipt');
          }
          const stored = decodeStoredMetricEvent(storedRow, candidate);

          return {
            replayed: action.replayed,
            metricId: definition.metricId,
            value: candidate.value,
            stored,
          } satisfies StoredMetricResult;
        });

        if (result === undefined) return reply.code(404).send({ error: 'not_found' });
        return reply.code(result.replayed ? 200 : 201).send({
          schemaVersion: 'kf.ml.metric-event-receipt.v1',
          replayed: result.replayed,
          run: {
            authorityId: request.params.authorityId,
            revisionId: request.params.revisionId,
          },
          metricDefinition: {
            authorityId: request.params.metricAuthorityId,
            revisionId: request.params.metricRevisionId,
            metricId: result.metricId,
          },
          event: {
            sequence: result.stored.sequence,
            recordedAt: result.stored.recordedAt,
            status: result.stored.status,
            value: result.value,
            eventDigest: result.stored.eventDigest,
          },
        });
      } catch (error: unknown) {
        if (error instanceof MlSchemaUnavailable) {
          return reply.code(503).send({ error: 'ml_schema_unavailable' });
        }
        if (error instanceof ActionRejected) {
          if (error.failure === 'object_not_visible') {
            return reply.code(404).send({ error: 'not_found' });
          }
          const status =
            error.failure === 'role_not_held' || error.failure === 'actor_not_authorized'
              ? 403
              : error.failure === 'version_conflict' ||
                  error.failure === 'illegal_transition' ||
                  error.failure === 'idempotency_conflict'
                ? 409
                : 400;
          return reply.code(status).send({ error: error.failure, message: error.message });
        }
        if (error instanceof MlRegistryRejected) {
          return reply.code(400).send({
            error: 'invalid_metric_event',
            message: error.message,
          });
        }
        if (error instanceof ProjectionError) {
          request.log.error({ err: error }, 'ML metric projection integrity check failed');
          return reply.code(500).send({ error: 'internal_error', requestId: request.id });
        }
        const failure = postgresFailure(error);
        if (failure.code === '23514' && /sealed run/i.test(failure.message ?? '')) {
          return reply.code(409).send({
            error: 'run_sealed',
            message: 'sealed runs cannot accept new metric events',
          });
        }
        if (failure.code === '23505') {
          return reply.code(409).send({
            error: 'metric_event_conflict',
            message: 'idempotency key or sequence conflicts with an existing metric event',
          });
        }
        if (failure.code === '42501') return reply.code(404).send({ error: 'not_found' });
        request.log.error({ err: error }, 'ML metric event append failed');
        return reply.code(500).send({ error: 'internal_error', requestId: request.id });
      }
    },
  );
}
