import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionRequest } from '@kf/actions';
import { digestOf, InMemoryObjectStore } from '@kf/artifacts';
import { bindPrincipal, withTransaction } from '@kf/database';
import {
  createAuthoredFragmentRevision,
  createCompilationBasis,
  createCompositionRevision,
  createDocumentActionAtoms,
  documentWorkspace,
  resolveDocumentWorkbenchTarget,
} from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import type { Caller } from '../../apps/api/src/routes/actions.js';
import type { DocumentRoutesOptions } from '../../apps/api/src/routes/documents/contracts.js';
import { registerDocumentWorkspaceRoute } from '../../apps/api/src/routes/documents/workspace-route.js';
import {
  createObject,
  registerTestDocumentCompiler,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * `GET /documents/:id/workbench` against the real schema.
 *
 * The route's own test answers every query from a fake, so a query naming a column the schema
 * does not have (`composition_revision.holder_id`, `composition_revision.classification`) passed
 * there and failed every real request with a 500. Here each workbench query is planned and run by
 * PostgreSQL: a composition with a finalized basis is served, and a record in another organization
 * reads exactly as an id that names nothing.
 */

const COMPILER = {
  name: 'synthetic-unqualified-liminal',
  version: 'test-only',
  protocol: 'kf-document-v1' as const,
  commitSha: '7'.repeat(40),
  cargoLockDigest: '8'.repeat(64),
  executableDigest: '9'.repeat(64),
  runtimeClosureDigest: 'a'.repeat(64),
  qualification: { state: 'not_run' as const, receiptDigest: null, ratified: false },
};

let h: Harness;
let f: Fixtures;
let foreign: Fixtures;
let app: FastifyInstance;
let compositionId: string;
let compositionRevisionId: string;
let fragmentId: string;
let who: Caller;

function reviewer(): Caller {
  return {
    actorId: f.reviewerId,
    actingRoleId: f.reviewerRoleId,
    organizationId: f.organizationId,
    maxClassification: 'restricted',
    authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
  };
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  foreign = await seedFixtures(h.adminPool, { auditClearance: false });
  await registerTestDocumentCompiler(h.adminPool, COMPILER, f.reviewerId);

  const store = new InMemoryObjectStore();
  const bytes = Buffer.from('# Workbench constitution\n');
  const sha256 = digestOf(bytes);
  const key = `ingest/${f.organizationId}/${sha256}`;
  await store.put(key, bytes, 'text/markdown');
  const execute = createFabricDispatcher(
    h.pool,
    createDocumentActionAtoms({ store, parser: { parse: async () => undefined } }),
  );
  let sequence = 0;
  const call = (
    actionType: string,
    targetIds: readonly string[],
    payload: Readonly<Record<string, unknown>>,
    author = false,
  ) => {
    sequence += 1;
    return execute({
      actionType,
      actorId: author ? f.performerId : f.reviewerId,
      actingRoleId: author ? f.performerRoleId : f.reviewerRoleId,
      targetIds,
      payload,
      idempotencyKey: `workbench-db-${actionType}-${String(sequence)}`,
      requestId: `workbench-db-${String(sequence)}`,
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    } as ActionRequest);
  };

  const artifact = await call('attach_evidence', [], {
    title: 'workbench-constitution.md',
    artifact_kind: 'document',
    sha256,
    size_bytes: bytes.length,
    media_type: 'text/markdown',
    storage_uri: key,
  });
  const artifactVersionId = await withTransaction(h.pool, async (tx) => {
    await bindPrincipal(tx, reviewer());
    return (
      await tx.one<{ id: string }>(
        'select id from content.artifact_version where artifact_id = $1',
        [artifact.objectIds[0]],
      )
    ).id;
  });
  const holder = {
    kind: 'fabric_native',
    artifact_version_id: artifactVersionId,
    content_digest: sha256,
  };
  const fragmentRevisionId = randomUUID();
  fragmentId = (
    await call('add_authored_fragment', [], {
      title: 'Workbench fragment',
      stable_key: `workbench.fragment.${randomUUID()}`,
      holder_id: randomUUID(),
      holder,
      revision_id: fragmentRevisionId,
      media_type: 'text/markdown',
      classification: 'internal',
      document_policy: 'ordinary',
    })
  ).objectIds[0]!;
  compositionRevisionId = randomUUID();
  compositionId = (
    await call(
      'add_document_composition',
      [],
      {
        title: 'Workbench composition',
        stable_key: `workbench.composition.${randomUUID()}`,
        holder_id: randomUUID(),
        holder,
        revision_id: compositionRevisionId,
        classification: 'internal',
        document_policy: 'ordinary',
        inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: fragmentRevisionId }],
      },
      true,
    )
  ).objectIds[0]!;
  const basis = createCompilationBasis({
    protocol: 'kf-document-v1',
    rootCompositionRevisionId: compositionRevisionId,
    fragmentRevisions: [
      createAuthoredFragmentRevision({
        id: fragmentRevisionId,
        fragmentId,
        previousRevisionId: null,
        mediaType: 'text/markdown',
        classification: 'internal',
        state: 'active',
        holder: {
          kind: 'fabric_native',
          subjectId: fragmentId,
          artifactVersionId,
          contentDigest: sha256,
        },
      }),
    ],
    compositionRevisions: [
      createCompositionRevision({
        id: compositionRevisionId,
        compositionId,
        previousRevisionId: null,
        classification: 'internal',
        inputs: [{ ordinal: 1, role: 'fragment', fragmentRevisionId }],
      }),
    ],
    bindings: [],
    targetProfiles: [{ target: 'markdown', profileDigest: '4'.repeat(64) }],
    ontologyDigest: '5'.repeat(64),
    policyDigest: '6'.repeat(64),
    compiler: { kind: 'liminal', ...COMPILER },
  });
  await call('request_document_compilation', [compositionId], { basis_id: randomUUID(), basis });

  app = Fastify({ logger: false });
  registerDocumentWorkspaceRoute(app, {
    pool: h.pool,
    identify: async () => who,
  } as unknown as DocumentRoutesOptions);
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

describe('the workbench against the real schema', () => {
  it('serves a composition with a finalized basis: its holder, its classification, its nodes', async () => {
    who = reviewer();
    const response = await app.inject({
      method: 'GET',
      url: `/documents/${compositionId}/workbench`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      status: string;
      target: { kind: string; objectId: string; baseRevisionId: string; classification: string };
      composition: {
        rootRevisionId: string;
        nodes: { revisionId: string; classification: string }[];
      };
    };
    expect(body.status).toBe('ready');
    expect(body.target).toMatchObject({
      kind: 'document_composition',
      objectId: compositionId,
      baseRevisionId: compositionRevisionId,
      classification: 'internal',
    });
    expect(body.composition.rootRevisionId).toBe(compositionRevisionId);
    expect(body.composition.nodes).toEqual([
      expect.objectContaining({ revisionId: compositionRevisionId, classification: 'internal' }),
    ]);
  });

  it('plans every workbench query for an id that names nothing', async () => {
    const outcome = await withTransaction(h.pool, async (tx) => {
      await bindPrincipal(tx, reviewer());
      const target = await resolveDocumentWorkbenchTarget(tx, randomUUID());
      const any = await resolveDocumentWorkbenchTarget(tx, compositionId);
      if (any.status !== 'ready') throw new Error(any.status);
      // Every downstream query, over a basis that has no runs, nodes or links.
      const workspace = await documentWorkspace(tx, { ...any.row, basis_id: randomUUID() });
      return { target, workspace };
    });
    expect(outcome.target).toEqual({ status: 'unavailable' });
    const workspace = outcome.workspace;
    if (workspace.status !== 'ready') throw new Error(workspace.status);
    expect(workspace.composition.nodes).toEqual([]);
  });

  it('answers a record in another organization exactly as an id that names nothing', async () => {
    const foreignRecord = await createObject(h.adminPool, foreign, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Another organization’s decision',
      createdBy: foreign.performerId,
    });
    who = reviewer();
    const asked = [foreignRecord, randomUUID()];
    const responses = [];
    for (const id of asked) {
      responses.push(await app.inject({ method: 'GET', url: `/documents/${id}/workbench` }));
    }
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ status: 'unavailable' });
      expect(response.rawPayload.equals(responses[0]!.rawPayload)).toBe(true);
    }
  });
});
