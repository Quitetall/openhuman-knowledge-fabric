import type { FastifyInstance } from 'fastify';
import { setResolvedAccessContext, withTransaction } from '@kf/database';
import { enumerateRelevanceGraph } from '@kf/documents';
import {
  project,
  ProjectionRefused,
  renderProjection,
  type ProjectionParameterValue,
  type ProjectionRenderTarget,
} from '@kf/projections';
import type { ProjectionDefinition } from '@kf/ontology-compiler';
import { readCurrentProjectionCorpus } from './current-master-record.js';
export { liveVerifications, projectionMembersOf } from './master-record-members.js';
import { refuseUnidentified } from '../actions.js';
import type { DocumentRoutesOptions } from './contracts.js';

const TARGETS = new Set<ProjectionRenderTarget>(['json', 'markdown', 'html']);

/** Coerce query-string parameters to the definition's declared types; anything else is left for the engine to refuse. */
export function coerceParameters(
  definition: ProjectionDefinition,
  query: Readonly<Record<string, unknown>>,
): Record<string, ProjectionParameterValue> {
  const out: Record<string, ProjectionParameterValue> = {};
  const declared = new Map(definition.parameters.map((p) => [p.name, p]));
  for (const [name, raw] of Object.entries(query)) {
    if (name === 'format') continue;
    const param = declared.get(name);
    const text = Array.isArray(raw) ? String(raw[0]) : String(raw);
    if (param === undefined) {
      out[name] = text; // the engine names it as unknown
      continue;
    }
    if (param.type === 'integer') {
      // Refuse before converting: Number('9999999999999999999') is a lossy value that would
      // reach the engine already wrong. Left as text, the engine names it as not an integer.
      const parsed = /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
      out[name] = Number.isSafeInteger(parsed) ? parsed : text;
    } else if (param.type === 'boolean') {
      out[name] = text === 'true' ? true : text === 'false' ? false : text;
    } else {
      out[name] = text;
    }
  }
  return out;
}

/**
 * `GET /master-record/projections/:definitionId[?format=json|markdown|html&<param>=…]`
 *
 * One engine for every surface: the JSON target IS the canonical Result the web page renders,
 * and markdown/html are renderings of that same Result with the same projection digest.
 */
export function registerMasterRecordProjectionRoute(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): void {
  app.get<{ Params: { definitionId: string }; Querystring: Record<string, unknown> }>(
    '/master-record/projections/:definitionId',
    async (request, reply) => {
      const definitions = options.projections;
      if (definitions === undefined) {
        return reply.code(503).send({
          error: 'projections_unavailable',
          message: 'no compiled projection definitions',
        });
      }
      const definition = definitions.byId(request.params.definitionId);
      if (definition === undefined) {
        return reply.code(404).send({ error: 'projection_not_found' });
      }
      const format = String(request.query['format'] ?? 'json') as ProjectionRenderTarget;
      if (!TARGETS.has(format)) {
        return reply.code(400).send({ error: 'unknown_format', formats: [...TARGETS] });
      }

      let identity;
      try {
        identity = await options.identify({
          headers: request.headers as Record<string, unknown>,
        });
      } catch (error: unknown) {
        return refuseUnidentified(reply, error);
      }

      return withTransaction(options.pool, async (tx) => {
        await setResolvedAccessContext(tx, {
          subjectId: identity.actorId,
          assignmentId: identity.actingRoleId,
          organizationId: identity.organizationId,
          requestedClassification: identity.maxClassification,
          attestation: identity.attestation,
        });
        try {
          const parameters = coerceParameters(definition, request.query);
          const reading = await readCurrentProjectionCorpus(tx, identity, definition, parameters);
          if (reading.status === 'missing')
            return reply.code(404).send({ error: 'master_record_not_found' });
          if (reading.status === 'stale')
            return reply.code(409).send({ error: 'master_record_stale' });
          const corpus = reading.corpus;
          const graph = await enumerateRelevanceGraph(tx);
          const result = project({
            definition,
            parameters,
            corpus,
            graph,
          });
          const rendered = renderProjection(
            result,
            format,
            options.links === undefined ? {} : { links: options.links },
          );
          return reply
            .header('content-type', rendered.mediaType)
            .header('x-kf-projection-digest', result.projectionDigest)
            .header('x-kf-corpus-digest', corpus.corpusDigest)
            .send(rendered.bytes);
        } catch (error: unknown) {
          // An unlabelled member is this server's defect, not the caller's request: it is
          // left to surface as a 500 rather than dressed as a 400.
          if (error instanceof ProjectionRefused && error.reason !== 'unlabelled_member') {
            const status = error.reason === 'budget_exceeded' ? 413 : 400;
            return reply
              .code(status)
              .send({ error: 'projection_refused', reason: error.reason, message: error.message });
          }
          throw error;
        }
      });
    },
  );
}
