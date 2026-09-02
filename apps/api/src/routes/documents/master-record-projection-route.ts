import type { FastifyInstance } from 'fastify';
import { setResolvedAccessContext, withTransaction } from '@kf/database';
import {
  assertPermissionSetInvariant,
  enumeratePermittedSet,
  enumerateRelevanceGraph,
  latestMasterRecord,
  type MasterRecordManifest,
  type PermissionMember,
} from '@kf/documents';
import {
  project,
  ProjectionRefused,
  renderProjection,
  type ProjectionCorpus,
  type ProjectionMember,
  type ProjectionParameterValue,
  type ProjectionRenderTarget,
} from '@kf/projections';
import type { ProjectionDefinition } from '@kf/ontology-compiler';
import { unidentified } from '../actions.js';
import type { DocumentRoutesOptions } from './contracts.js';

const TARGETS = new Set<ProjectionRenderTarget>(['json', 'markdown', 'html']);

/**
 * Turn the master record's persisted members into what the engine reads. A projection sees the
 * corpus and nothing else: this mapping adds no field the manifest does not already carry.
 */
export function projectionMembersOf(
  manifest: Pick<MasterRecordManifest, 'included' | 'withdrawn'>,
): ProjectionMember[] {
  const lifecycle = (member: PermissionMember): string | undefined => {
    const envelope = member.content?.['core.object'];
    if (typeof envelope !== 'object' || envelope === null) return undefined;
    const state = (envelope as { lifecycle_state?: unknown }).lifecycle_state;
    return typeof state === 'string' ? state : undefined;
  };
  const map = (member: PermissionMember, itemState: 'included' | 'withdrawn'): ProjectionMember => {
    const state = lifecycle(member);
    return {
      objectId: member.objectId,
      objectType: member.objectType,
      organizationId: member.organizationId,
      classification: member.classification,
      contentDigest: member.contentDigest,
      itemState,
      ...(state === undefined ? {} : { lifecycleState: state }),
      ...(member.title === undefined ? {} : { title: member.title }),
      ...(member.content === undefined ? {} : { content: member.content }),
      ...(member.withdrawnAt === undefined ? {} : { withdrawnAt: member.withdrawnAt }),
      ...(member.withdrawalReason === undefined
        ? {}
        : { withdrawalReason: member.withdrawalReason }),
    };
  };
  return [
    ...manifest.included.map((m) => map(m, 'included')),
    ...manifest.withdrawn.map((m) => map(m, 'withdrawn')),
  ];
}

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
        return reply.code(401).send(unidentified(error));
      }

      return withTransaction(options.pool, async (tx) => {
        await setResolvedAccessContext(tx, {
          subjectId: identity.actorId,
          assignmentId: identity.actingRoleId,
          organizationId: identity.organizationId,
          requestedClassification: identity.maxClassification,
        });
        const record = await latestMasterRecord(tx, identity.actorId, identity.organizationId);
        if (record === undefined) return reply.code(404).send({ error: 'master_record_not_found' });
        const manifest = record['manifest'] as MasterRecordManifest;
        const included = Array.isArray(manifest.included) ? manifest.included : [];
        const withdrawn = Array.isArray(manifest.withdrawn) ? manifest.withdrawn : [];

        // The same staleness rule as GET /master-record: a projection of a stale corpus is a
        // reading of something the person is no longer authorized to see exactly.
        const permitted = await enumeratePermittedSet(
          tx,
          identity.actorId,
          identity.organizationId,
        );
        try {
          assertPermissionSetInvariant(
            { corpusDigest: String(record['corpus_digest']), included, withdrawn },
            permitted,
          );
        } catch {
          return reply.code(409).send({ error: 'master_record_stale' });
        }

        const corpus: ProjectionCorpus = {
          personId: identity.actorId,
          organizationId: identity.organizationId,
          corpusDigest: String(record['corpus_digest']),
          members: projectionMembersOf({ included, withdrawn }),
        };
        const graph = await enumerateRelevanceGraph(tx);
        try {
          const result = project({
            definition,
            parameters: coerceParameters(definition, request.query),
            corpus,
            graph,
          });
          const rendered = renderProjection(result, format);
          return reply
            .header('content-type', rendered.mediaType)
            .header('x-kf-projection-digest', result.projectionDigest)
            .header('x-kf-corpus-digest', corpus.corpusDigest)
            .send(rendered.bytes);
        } catch (error: unknown) {
          if (error instanceof ProjectionRefused) {
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
