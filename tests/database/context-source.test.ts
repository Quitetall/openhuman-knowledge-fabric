import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore, digestOf } from '@kf/artifacts';
import { reaches } from '@kf/authorization';
import { digestBytes, taggedDigest } from '@kf/canonicalization';
import { issueAttestation, PrincipalRefused, withTransaction, type Tx } from '@kf/database';
import {
  atomsFromPandoc,
  createDocumentActionAtoms,
  documentConversionLossDigest,
  documentProjectionDigest,
  enumeratePermittedSet,
  latestMasterRecord,
  type DocumentParser,
} from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { loadProjectionDefinitions } from '@kf/projections';
import type { SemanticRetrieval } from '@kf/retrieval';
import type { Caller } from '../../apps/api/src/routes/actions.js';
import { registerContextSourceRoutes } from '../../apps/api/src/routes/context-source.js';
import { contextFacts } from '../../apps/api/src/routes/context-source/record.js';
import { agentContextReader } from '../../apps/api/src/routes/documents/agent-context.js';
import { planDeclareAgent, runDeclareAgent } from '../../apps/api/src/admin/declare-agent.js';
import {
  bindContext,
  bindReader,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * The context source LAMU compiles from (apps/api/src/routes/context-source.ts), against a real
 * database, through the real routes, with a stand-in for the retrieval engine only.
 *
 *   - retrieve + read: the caller's semantic list, kept to their agent_context, each reference's
 *     digest the SHA-256 of exactly what read returns; both recorded, bound to the corpus digest.
 *   - current authority: a grant revoked between retrieve and read is 403 KF-CTX-002; a record
 *     revised between them is 409 KF-CTX-003; a record the master record does not include at its
 *     current revision is 409 KF-CTX-004 (and left out of a retrieval); each refusal is recorded.
 *   - existence: a record in another organization, an id that names nothing, a malformed id and a
 *     record above the caller's clearance all answer the same 404 byte for byte, and the record of
 *     each names nothing.
 *   - a person cleared to `internal` who asks for `restricted` is refused before anything is read,
 *     and at `internal` never retrieves or reads above it; the named restricted record is read by
 *     someone cleared (the positive control).
 *   - a delegated token's declared agent is recorded by the database (ADR 0035).
 */

const ROOT = join(import.meta.dirname, '..', '..');
const ARTIFACT = join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json');
const AGENT = 'lamu-context-compiler';
const TRACE = 'sha256:context-source-test-trace';

let h: Harness;
let f: Fixtures;
let foreign: Fixtures;
let app: FastifyInstance;
const store = new InMemoryObjectStore();

/** Who the routes think is calling. Set per request. */
let who: Caller;
/** What the stand-in engine ranks, in order, before it masks. */
let engineIds: string[] = [];
/** Whether the stand-in engine masks by the caller's clearance and grants, as the real one does. */
let engineMasks = true;

let capped: { personId: string; assignmentId: string };
let internalOnly: { personId: string; assignmentId: string };

/** A parser that reads text/plain as one paragraph per line, and declines everything else. */
const parser: DocumentParser = {
  async parse(bytes, mediaType) {
    if (mediaType !== 'text/plain') return undefined;
    const atoms = atomsFromPandoc({
      'pandoc-api-version': [1, 23, 1],
      blocks: bytes
        .toString('utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => ({ t: 'Para', c: [{ t: 'Str', c: line.trim() }] })),
    });
    const claims = atoms.map(({ digest: _digest, ...claim }) => claim);
    return {
      parser: 'test-parser',
      parserVersion: '1',
      projectionContract: 'test.atoms.v1',
      sourceDigest: digestOf(bytes),
      atoms,
      conversionLoss: [],
      lossDigest: documentConversionLossDigest([]),
      contentDigest: documentProjectionDigest('test.atoms.v1', claims, []),
    };
  },
};

const execute = () => createFabricDispatcher(h.pool, createDocumentActionAtoms({ store, parser }));

const reviewer = (): Caller => person(f.reviewerId, f.reviewerRoleId);
const performer = (): Caller => person(f.performerId, f.performerRoleId);

function person(
  actorId: string,
  actingRoleId: string,
  maxClassification = 'restricted',
  organizationId = f.organizationId,
): Caller {
  return {
    actorId,
    actingRoleId,
    organizationId,
    maxClassification,
    authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
  };
}

/** A text file attached as evidence by the reviewer, indexed for search. */
async function attachText(key: string, text: string, classification: string): Promise<string> {
  const bytes = Buffer.from(text, 'utf8');
  const sha256 = digestOf(bytes);
  const storageUri = `ingest/${f.organizationId}/${sha256}`;
  await store.put(storageUri, bytes, 'text/plain');
  const result = await execute()({
    ...reviewer(),
    targetIds: [],
    actionType: 'attach_evidence',
    idempotencyKey: key,
    payload: {
      title: key,
      artifact_kind: 'document',
      classification,
      sha256,
      size_bytes: bytes.length,
      media_type: 'text/plain',
      storage_uri: storageUri,
    },
  });
  const id = result.objectIds[0]!;
  await index(id);
  return id;
}

async function index(id: string): Promise<void> {
  await withTransaction(h.pool, async (tx) => {
    await bindReader(tx, f, f.reviewerId);
    await tx.query('select search.index_object($1)', [id]);
  });
}

/** The person's own act, as the web application performs it on a stale record. */
async function compile(caller: Caller): Promise<void> {
  const compiled = await execute()({
    actionType: 'compile_master_record',
    actorId: caller.actorId,
    actingRoleId: caller.actingRoleId,
    targetIds: [caller.actorId],
    organizationId: caller.organizationId,
    maxClassification: caller.maxClassification,
    idempotencyKey: `context-source-${randomUUID()}`,
    reason: `compile before a context read ${randomUUID()}`,
  });
  expect(compiled.status).toBe('applied');
}

async function grant(objectId: string, principalId: string): Promise<string> {
  await execute()({
    ...reviewer(),
    targetIds: [objectId],
    actionType: 'grant_access',
    idempotencyKey: `grant-${randomUUID()}`,
    reason: 'the capped reader works on this file',
    payload: { principal_kind: 'person', principal_id: principalId, capability: 'read' },
  });
  return (
    await withTransaction(h.adminPool, (tx) =>
      tx.one<{ id: string }>(
        `select id from org.access_grant where principal_id = $1 and scope_object_id = $2
            and revoked_at is null`,
        [principalId, objectId],
      ),
    )
  ).id;
}

async function retrieve(
  caller: Caller,
  query = 'context source probe',
  limit = 10,
): Promise<LightMyRequestResponse> {
  who = caller;
  return app.inject({ method: 'POST', url: '/context-source/retrieve', payload: { query, limit } });
}

async function read(caller: Caller, reference: unknown): Promise<LightMyRequestResponse> {
  who = caller;
  return app.inject({
    method: 'POST',
    url: '/context-source/read',
    payload: reference as Record<string, unknown>,
  });
}

interface Reference {
  adapter: string;
  record: string;
  revision: string;
  digest: string;
}

function referencesOf(response: LightMyRequestResponse): Reference[] {
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { references: Reference[] }).references;
}

interface DisclosureRow extends Record<string, unknown> {
  operation: string;
  refusal: string | null;
  corpus_digest: string | null;
  object_id: string | null;
  revision: string | null;
  text_digest: string | null;
  references_digest: string | null;
  reference_count: number | null;
  omitted_count: number | null;
  agent_participation: string | null;
}

/** Every context disclosure since `since`, oldest first, as the owner sees them. */
async function disclosuresSince(since: Date): Promise<DisclosureRow[]> {
  return withTransaction(h.adminPool, (tx) =>
    tx.query<DisclosureRow>(
      `select operation, refusal, corpus_digest, object_id, revision, text_digest,
              references_digest, reference_count, omitted_count, agent_participation
         from search.context_disclosure
        where recorded_at >= $1
        order by recorded_at, id`,
      [since],
    ),
  );
}

async function corpusDigestOf(caller: Caller): Promise<string> {
  const record = await withTransaction(h.adminPool, (tx) =>
    latestMasterRecord(tx, caller.actorId, caller.organizationId),
  );
  return String(record?.['corpus_digest']);
}

/** Database time, so "since" never races the clock of this process. */
async function now(): Promise<Date> {
  return (await withTransaction(h.adminPool, (tx) => tx.one<{ now: Date }>('select now() as now')))
    .now;
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  foreign = await seedFixtures(h.adminPool, { auditClearance: false });

  // A person whose role reads only `public` organization-wide: what they read beyond it is granted.
  // And a person cleared only to `internal`, whose role reads organization-wide up to that.
  const addPerson = async (
    title: string,
    clearance: string,
    roleCeiling: string | null,
  ): Promise<{ personId: string; assignmentId: string }> => {
    const personId = await createObject(h.adminPool, f, {
      type: 'person',
      domain: 'organization',
      state: 'active',
      title,
      createdBy: f.reviewerId,
    });
    const assignmentId = await createObject(h.adminPool, f, {
      type: 'role_assignment',
      domain: 'organization',
      state: 'active',
      title: `${title} assignment`,
      createdBy: f.reviewerId,
    });
    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        'insert into org.person (id, display_name, organization) values ($1, $2, $3)',
        [personId, title, f.organizationId],
      );
      await tx.query(
        `insert into org.person_clearance
           (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
         values ($1, $2, $3, $4, $5, 'fixture clearance for a context-source reader')`,
        [personId, f.organizationId, clearance, f.reviewerId, f.clearanceActionId],
      );
      await tx.query(
        `insert into org.role_assignment
           (id, subject_id, role_id, scope_id, classification_ceiling, valid_to)
         values ($1, $2, 'performer', $3, $4, now() + interval '300 days')`,
        [assignmentId, personId, f.organizationId, roleCeiling],
      );
    });
    return { personId, assignmentId };
  };
  capped = await addPerson('Capped context reader', 'restricted', 'public');
  internalOnly = await addPerson('Internal-only context reader', 'internal', null);

  const plan = planDeclareAgent({
    clientId: AGENT,
    declaredBy: f.reviewerId,
    reason: 'LAMU context compiler under test',
  });
  if (!plan.ok) throw new Error(plan.refusals.join('; '));
  await runDeclareAgent(h.adminPool, plan.decision);

  app = Fastify({ logger: false });
  // As app.ts answers it: a principal the database refused to bind is out of scope, and absent.
  app.setErrorHandler((error, _request, reply) =>
    (error as unknown) instanceof PrincipalRefused
      ? reply.code(404).send({ error: 'not_found' })
      : reply.code(500).send({ error: 'internal_error' }),
  );
  const semantic: Pick<SemanticRetrieval, 'rank'> = {
    async rank(run, query) {
      let ids = engineIds;
      if (engineMasks) {
        // What the real engine's mask does: score only records within the caller's clearance
        // (row security) that a grant reaches.
        const rows = await run((tx) =>
          tx.query<{ id: string; classification: string }>(
            'select id, classification from core.object where id = any($1::uuid[])',
            [engineIds],
          ),
        );
        const visible = new Map(rows.map((row) => [row.id, row.classification]));
        ids = engineIds.filter((id) => {
          const classification = visible.get(id);
          return classification !== undefined && reaches(query.coverage, { id, classification });
        });
      }
      return {
        status: 'ranked',
        hits: ids.slice(0, query.k).map((objectId, index) => ({
          objectId,
          score: 1 - index / 100,
          rank: index + 1,
        })),
        traceDigest: TRACE,
        ranking: 'test.semantic.v1',
      };
    },
  };
  await registerContextSourceRoutes(app, {
    pool: h.pool,
    identify: async () => who,
    store,
    semantic,
  });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

describe('retrieve and read, allowed', () => {
  it('serves the caller’s semantic list as references whose digest is the text read returns', async () => {
    const text = 'Context source probe: alpha bearing torque limits.\nSecond line.\n';
    const alpha = await attachText('context-alpha', text, 'internal');
    const facts = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Context source probe decision',
      createdBy: f.performerId,
    });
    await index(facts);
    await compile(performer());
    const since = await now();

    engineIds = [alpha, facts];
    const references = referencesOf(await retrieve(performer()));
    expect(references.map((r) => r.record)).toEqual([alpha, facts]);
    const [alphaRef, factsRef] = references as [Reference, Reference];
    expect(alphaRef).toEqual({
      adapter: 'knowledge-fabric',
      record: alpha,
      revision: expect.stringMatching(/^[0-9a-f]{64}$/u),
      digest: digestBytes(Buffer.from(text, 'utf8')),
    });

    const alphaRead = await read(performer(), alphaRef);
    expect(alphaRead.statusCode, alphaRead.body).toBe(200);
    const record = alphaRead.json() as Record<string, unknown>;
    // Exactly the fields LAMU's adapter accepts (deny_unknown_fields).
    expect(Object.keys(record).sort()).toEqual(
      ['classification', 'localOnly', 'retention', 'schema', 'source', 'text', 'trust'].sort(),
    );
    expect(record).toEqual({
      schema: 'kf.context-source-record/v1',
      source: alphaRef,
      text,
      classification: 'internal',
      trust: 'untrusted',
      localOnly: true,
      retention: 'ephemeral',
    });

    // A record whose source is not text is read as its facts, canonical, digest and all.
    const factsRead = await read(performer(), factsRef);
    expect(factsRead.statusCode, factsRead.body).toBe(200);
    const factsText = (factsRead.json() as { text: string }).text;
    expect(JSON.parse(factsText)).toMatchObject({
      schema: 'kf.context-facts/v2',
      objectId: facts,
      objectType: 'decision_record',
      title: 'Context source probe decision',
    });
    expect(digestBytes(Buffer.from(factsText, 'utf8'))).toBe(factsRef.digest);

    // Recorded: the result set and each read, bound to the person's agent_context corpus.
    const corpus = await corpusDigestOf(performer());
    const rows = await disclosuresSince(since);
    expect(rows).toEqual([
      expect.objectContaining({
        operation: 'retrieve',
        refusal: null,
        corpus_digest: corpus,
        object_id: null,
        references_digest: taggedDigest('kf-context-source-references-v1', { references }),
        reference_count: 2,
        omitted_count: 0,
        agent_participation: null,
      }),
      expect.objectContaining({
        operation: 'read',
        refusal: null,
        corpus_digest: corpus,
        object_id: alpha,
        revision: alphaRef.revision,
        text_digest: alphaRef.digest,
      }),
      expect.objectContaining({
        operation: 'read',
        refusal: null,
        corpus_digest: corpus,
        object_id: facts,
        revision: factsRef.revision,
        text_digest: factsRef.digest,
      }),
    ]);
    // The engine's trace digest is recorded as for any semantic answer (RQ-219).
    const traces = await withTransaction(h.adminPool, (tx) =>
      tx.query('select 1 from retrieval.disclosure where trace_digest = $1 and recorded_at >= $2', [
        TRACE,
        since,
      ]),
    );
    expect(traces).toHaveLength(1);

    // Nothing the log holds carries text.
    const dump = JSON.stringify(
      await withTransaction(h.adminPool, (tx) =>
        tx.query('select * from search.context_disclosure'),
      ),
    );
    expect(dump).not.toContain('alpha bearing');
    expect(dump).not.toContain('Context source probe');
  });

  it('serves a non-text record as its content facts, never its grants, their reasons or other records’ rows', async () => {
    const REASON = 'need-to-know-reason-needle-5d3f';
    const bytes = Buffer.from('%PDF-1.7 not text\n', 'utf8');
    const sha256 = digestOf(bytes);
    const storageUri = `ingest/${f.organizationId}/${sha256}`;
    await store.put(storageUri, bytes, 'application/pdf');
    const pdf = (
      await execute()({
        ...reviewer(),
        targetIds: [],
        actionType: 'attach_evidence',
        idempotencyKey: 'context-facts-pdf',
        payload: {
          title: 'Supplier audit report.pdf',
          artifact_kind: 'document',
          classification: 'internal',
          sha256,
          size_bytes: bytes.length,
          media_type: 'application/pdf',
          storage_uri: storageUri,
          revision_label: 'R02',
        },
      })
    ).objectIds[0]!;
    await index(pdf);
    const grantId = await execute()({
      ...reviewer(),
      targetIds: [pdf],
      actionType: 'grant_access',
      idempotencyKey: `grant-${randomUUID()}`,
      reason: REASON,
      payload: { principal_kind: 'person', principal_id: capped.personId, capability: 'read' },
    }).then(() =>
      withTransaction(h.adminPool, (tx) =>
        tx.one<{ id: string }>(
          `select id from org.access_grant where scope_object_id = $1 and revoked_at is null`,
          [pdf],
        ),
      ),
    );
    await compile(performer());
    engineIds = [pdf];
    const [reference] = referencesOf(await retrieve(performer()));
    const served = await read(performer(), reference);
    expect(served.statusCode, served.body).toBe(200);
    const text = (served.json() as { text: string }).text;
    expect(digestBytes(Buffer.from(text, 'utf8'))).toBe(reference!.digest);

    // Not who may see it, or why, or who wrote which row, or where the bytes are stored.
    const facts = JSON.parse(text) as Record<string, unknown>;
    for (const absent of [
      REASON,
      grantId.id,
      capped.personId,
      'access_grant',
      storageUri,
      'created_by',
      'row_version',
      f.reviewerId,
    ]) {
      expect(text, absent).not.toContain(absent);
    }

    // What the record says: its title, type, state, its own typed row and its file's version.
    expect(facts).toEqual({
      schema: 'kf.context-facts/v2',
      objectId: pdf,
      objectType: 'artifact',
      classification: 'internal',
      title: 'Supplier audit report.pdf',
      lifecycle_state: 'draft',
      enterprise_id: null,
      created_at: expect.any(String) as unknown,
      updated_at: expect.any(String) as unknown,
      records: {
        'content.artifact': expect.objectContaining({ artifact_kind: 'document' }) as unknown,
      },
      versions: [
        {
          version_no: 1,
          revision_label: 'R02',
          media_type: 'application/pdf',
          size_bytes: bytes.length,
          sha256,
          created_at: expect.any(String) as unknown,
        },
      ],
    });
    // A grant change moves the revision (the member digest covers the grants) and not the text:
    // the old reference is 409 KF-CTX-003, and the one retrieved after compiling has the same digest.
    await execute()({
      ...reviewer(),
      targetIds: [pdf],
      actionType: 'revoke_access',
      idempotencyKey: `revoke-${randomUUID()}`,
      reason: 'the capped reader is done with the audit',
      payload: { grant_id: grantId.id },
    });
    const moved = await read(performer(), reference);
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json()).toEqual({ error: 'revision_mismatch', rule: 'KF-CTX-003' });
    await compile(performer());
    const [after] = referencesOf(await retrieve(performer()));
    expect(after!.revision).not.toBe(reference!.revision);
    expect(after!.digest).toBe(reference!.digest);
    expect((await read(performer(), after)).statusCode).toBe(200);
  });

  it('keeps the list to the agent_context projection, which is the master record’s corpus', async () => {
    // agent_context's sections cover the corpus with a remainder (§59), so its included members
    // are exactly the claim's; the routes rely on that equivalence, and it is checked here.
    const definitions = loadProjectionDefinitions(ARTIFACT);
    const { projected, claimed } = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId);
      const outcome = await agentContextReader(definitions)(
        tx,
        { actorId: f.performerId, organizationId: f.organizationId },
        1_000_000,
      );
      if (outcome.status !== 'ready') throw new Error(outcome.status);
      const record = await latestMasterRecord(tx, f.performerId, f.organizationId);
      const manifest = record?.['manifest'] as { included: { objectId: string }[] };
      return {
        projected: outcome.projection.sections
          .flatMap((section) => section.members)
          .filter((member) => member.itemState === 'included')
          .map((member) => member.objectId)
          .sort(),
        claimed: manifest.included.map((member) => member.objectId).sort(),
      };
    });
    expect(projected).toEqual(claimed);
  });
});

describe('current authority between retrieve and read', () => {
  it('answers 403 KF-CTX-002 for a grant revoked since, and records the refusal', async () => {
    const granted = await attachText(
      'context-granted',
      'Granted file for the capped reader.\n',
      'internal',
    );
    const grantId = await grant(granted, capped.personId);
    const reader = person(capped.personId, capped.assignmentId);
    await compile(reader);

    engineIds = [granted];
    const [reference] = referencesOf(await retrieve(reader));
    expect(reference?.record).toBe(granted);

    await execute()({
      ...reviewer(),
      targetIds: [granted],
      actionType: 'revoke_access',
      idempotencyKey: `revoke-${randomUUID()}`,
      reason: 'the capped reader no longer works on this file',
      payload: { grant_id: grantId },
    });
    const since = await now();
    const refused = await read(reader, reference);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual({ error: 'grant_withdrawn', rule: 'KF-CTX-002' });
    expect(await disclosuresSince(since)).toEqual([
      expect.objectContaining({
        operation: 'read',
        refusal: 'KF-CTX-002',
        corpus_digest: null,
        object_id: granted,
        revision: reference!.revision,
        text_digest: reference!.digest,
      }),
    ]);
  });

  it('answers 409 KF-CTX-003 for a record revised since, and records the refusal', async () => {
    const revised = await attachText(
      'context-revised',
      'A file that will be revised.\n',
      'internal',
    );
    await compile(performer());
    engineIds = [revised];
    const [reference] = referencesOf(await retrieve(performer()));
    expect(reference?.record).toBe(revised);

    await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f, f.reviewerId);
      await tx.query(
        `update core.object set title = title || ' (revised)', row_version = row_version + 1
          where id = $1`,
        [revised],
      );
    });
    const since = await now();
    const refused = await read(performer(), reference);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toEqual({ error: 'revision_mismatch', rule: 'KF-CTX-003' });
    expect(await disclosuresSince(since)).toEqual([
      expect.objectContaining({ operation: 'read', refusal: 'KF-CTX-003', object_id: revised }),
    ]);
  });

  it('answers 409 KF-CTX-004 for a record the master record does not include at that revision', async () => {
    const steady = await attachText(
      'context-steady',
      'Nothing about this file changes.\n',
      'internal',
    );
    await compile(performer());
    engineIds = [steady];
    const [reference] = referencesOf(await retrieve(performer()));
    // Something else in the organization changes: this record is still in the claim at the same
    // revision, so it still reads.
    const later = await attachText(
      'context-later',
      'A file added after the master record was compiled.\n',
      'internal',
    );
    expect((await read(performer(), reference)).statusCode).toBe(200);

    // The new record is readable, but not in the person's agent_context until they compile: the
    // retrieval leaves it out (and counts it), and a read of its exact current reference is 409.
    const since = await now();
    engineIds = [later];
    expect(referencesOf(await retrieve(performer()))).toEqual([]);
    const current = await withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId);
      const [member] = await enumeratePermittedSet(tx, f.performerId, f.organizationId, undefined, [
        later,
      ]);
      return {
        adapter: 'knowledge-fabric',
        record: later,
        revision: member!.contentDigest,
        digest: digestBytes(Buffer.from('A file added after the master record was compiled.\n')),
      };
    });
    const refused = await read(performer(), current);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toEqual({ error: 'master_record_stale', rule: 'KF-CTX-004' });
    expect(await disclosuresSince(since)).toEqual([
      expect.objectContaining({
        operation: 'retrieve',
        refusal: null,
        reference_count: 0,
        omitted_count: 1,
      }),
      expect.objectContaining({ operation: 'read', refusal: 'KF-CTX-004', object_id: later }),
    ]);

    // Compiled, the same reference reads, and the retrieval serves it.
    await compile(performer());
    expect((await read(performer(), current)).statusCode).toBe(200);
    expect(referencesOf(await retrieve(performer()))).toEqual([current]);
  });
});

describe('what does not exist, and what is not yours, is one 404', () => {
  it('answers a foreign record, an absent id, a malformed id and an ungranted record identically', async () => {
    const foreignRecord = await createObject(h.adminPool, foreign, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Another organization’s decision',
      createdBy: foreign.performerId,
    });
    const ungranted = await attachText(
      'context-ungranted',
      'Never granted to the capped reader.\n',
      'internal',
    );
    const reader = person(capped.personId, capped.assignmentId);
    await compile(reader);
    const since = await now();

    const hex = (c: string) => c.repeat(64);
    const asked = [foreignRecord, randomUUID(), 'not-a-uuid', ungranted];
    const responses = [];
    for (const record of asked) {
      responses.push(
        await read(reader, {
          adapter: 'knowledge-fabric',
          record,
          revision: hex('a'),
          digest: hex('b'),
        }),
      );
    }
    const headers = (r: LightMyRequestResponse) => {
      const { 'x-request-id': _id, date: _date, ...rest } = r.headers;
      return rest;
    };
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.rawPayload.equals(responses[0]!.rawPayload)).toBe(true);
      expect(headers(response)).toEqual(headers(responses[0]!));
    }
    expect(responses[0]!.json()).toEqual({ error: 'not_found', rule: 'KF-CTX-001' });

    // Each refusal is recorded, and none names what was asked for.
    const rows = await disclosuresSince(since);
    expect(rows).toHaveLength(asked.length);
    for (const row of rows) {
      expect(row).toMatchObject({
        operation: 'read',
        refusal: 'KF-CTX-001',
        object_id: null,
        revision: null,
        text_digest: null,
      });
    }
    const dump = JSON.stringify(
      await withTransaction(h.adminPool, (tx) =>
        tx.query('select * from search.context_disclosure'),
      ),
    );
    expect(dump).not.toContain(foreignRecord);
  });
});

describe('a person cleared to internal never reads above it', () => {
  it('refuses a ceiling above clearance, and at their own ceiling serves nothing restricted', async () => {
    const restricted = await attachText(
      'context-restricted',
      'Named restricted record: tender pricing.\n',
      'restricted',
    );
    const open = await attachText(
      'context-open',
      'Open internal note on tender logistics.\n',
      'internal',
    );
    const atClearance = person(internalOnly.personId, internalOnly.assignmentId, 'internal');
    const asksHigh = { ...atClearance, maxClassification: 'restricted' };
    await compile(atClearance);
    await compile(performer());

    // Positive control: somebody cleared reads the named restricted record.
    engineIds = [restricted, open];
    const cleared = referencesOf(await retrieve(performer()));
    const restrictedRef = cleared.find((r) => r.record === restricted);
    expect(restrictedRef).toBeDefined();
    const control = await read(performer(), restrictedRef);
    expect(control.statusCode, control.body).toBe(200);
    expect((control.json() as { classification: string }).classification).toBe('restricted');

    // Asking above clearance: the database refuses to bind (org.resolve_effective_classification;
    // kf-attestor refuses the same request earlier, as 401 classification_not_granted). Out of
    // scope reads as absent, and nothing is served or recorded for a principal never bound.
    const since = await now();
    for (const response of [await retrieve(asksHigh), await read(asksHigh, restrictedRef)]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain('tender');
    }
    expect(await disclosuresSince(since)).toEqual([]);

    // At their own ceiling: the engine masks, and nothing above internal comes back.
    const theirs = referencesOf(await retrieve(atClearance));
    expect(theirs.map((r) => r.record)).toEqual([open]);

    // Their read of the restricted record is the not-found answer, byte for byte.
    const refused = await read(atClearance, restrictedRef);
    const absent = await read(atClearance, { ...restrictedRef, record: randomUUID() });
    expect(refused.statusCode).toBe(404);
    expect(refused.rawPayload.equals(absent.rawPayload)).toBe(true);

    // An engine that ignores the mask does not get the restricted record through: the whole
    // semantic list is refused rather than shortened (§64A), and so is the retrieval.
    engineMasks = false;
    try {
      const leaky = await retrieve(atClearance);
      expect(leaky.statusCode, leaky.body).toBe(503);
      expect(leaky.json()).toEqual({
        error: 'semantic_ranking_unavailable',
        rule: 'KF-CTX-006',
      });
      expect(leaky.body).not.toContain(restricted);
    } finally {
      engineMasks = true;
    }
  });
});

describe('an agent acting for a person is recorded by the database', () => {
  it('records the declared agent of a delegated token, and none for the person’s own', async () => {
    const note = await attachText('context-agent', 'Read by an agent for a person.\n', 'internal');
    await compile(performer());
    engineIds = [note];
    const attestation = await withTransaction(h.attestorPool, (tx: Tx) =>
      issueAttestation(tx, performer(), undefined, {
        agentClientId: AGENT,
        authorizedParty: AGENT,
      }),
    );
    const delegated: Caller = { ...performer(), attestation, agent: AGENT };
    const since = await now();
    const [reference] = referencesOf(await retrieve(delegated));
    expect((await read(delegated, reference)).statusCode).toBe(200);
    expect((await read(performer(), reference)).statusCode).toBe(200);
    expect((await disclosuresSince(since)).map((row) => row.agent_participation)).toEqual([
      AGENT,
      AGENT,
      null,
    ]);
  });
});

describe('the seam records only what it can stand behind', () => {
  const asApp = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTransaction(h.pool, async (tx) => {
      await bindReader(tx, f, f.performerId);
      return fn(tx);
    });
  const record = (tx: Tx, args: unknown[]) =>
    tx.query('select search.record_context_disclosure($1, $2, $3, $4, $5, $6, $7, $8, $9)', args);

  it('refuses an answer bound to a corpus that is not the person’s current master record', async () => {
    await expect(
      asApp((tx) =>
        record(tx, ['retrieve', null, 'c'.repeat(64), null, null, null, 'd'.repeat(64), 0, 0]),
      ),
    ).rejects.toThrow(/not the bound person's current master record/u);
  });

  it('refuses a read bound to a claim that did not include the record at that revision', async () => {
    const corpus = await corpusDigestOf(performer());
    await expect(
      asApp((tx) =>
        record(tx, [
          'read',
          null,
          corpus,
          f.organizationId,
          'e'.repeat(64),
          'f'.repeat(64),
          null,
          null,
          null,
        ]),
      ),
    ).rejects.toThrow(/is not in the master record it is bound to/u);
  });

  it('refuses to name a record in a not-found refusal', async () => {
    await expect(
      asApp((tx) =>
        record(tx, ['read', 'KF-CTX-001', null, f.organizationId, null, null, null, null, null]),
      ),
    ).rejects.toThrow(/not named/u);
  });

  it('refuses a withdrawn-grant refusal for a record the person was never shown', async () => {
    const foreignRecord = await createObject(h.adminPool, foreign, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Never in anybody’s claim here',
      createdBy: foreign.performerId,
    });
    await expect(
      asApp((tx) =>
        record(tx, ['read', 'KF-CTX-002', null, foreignRecord, null, null, null, null, null]),
      ),
    ).rejects.toThrow(/never in the bound person's master record/u);
  });

  it('keeps the pseudonym from the application, and names no person', async () => {
    await expect(
      asApp((tx) => tx.query('select asker_key from search.context_disclosure')),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asApp((tx) =>
        tx.query(
          `insert into search.context_disclosure (organization_id, operation, asker_rank, asker_key)
           values ($1, 'read', 0, '\\x00')`,
          [f.organizationId],
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
    const columns = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ name: string }>(
        `select column_name as name from information_schema.columns
          where table_schema = 'search' and table_name = 'context_disclosure'`,
      ),
    );
    for (const { name } of columns) {
      expect(name).not.toMatch(
        /(?:person|actor|subject|user|principal|asker)(?:_id)?$|(?:^|_)by$/u,
      );
    }
  });

  it('keeps a record’s facts canonical, so the digest never varies by serializer', () => {
    const member = {
      objectId: randomUUID(),
      objectType: 'decision_record',
      organizationId: f.organizationId,
      classification: 'internal' as const,
      contentDigest: 'e'.repeat(64),
      title: 'Order',
      content: { 'engineering.decision': { b: 1, a: 2 } },
    };
    expect(contextFacts(member)).toBe(
      contextFacts({ ...member, content: { 'engineering.decision': { a: 2, b: 1 } } }),
    );
    expect(contextFacts(member)).toContain('"a":2,"b":1');
  });
});

describe('local transport only', () => {
  it('refuses a forwarded or remote caller before identifying anybody', async () => {
    who = performer();
    const forwarded = await app.inject({
      method: 'POST',
      url: '/context-source/retrieve',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      payload: { query: 'anything', limit: 1 },
    });
    expect(forwarded.statusCode).toBe(403);
    expect(forwarded.json()).toEqual({ error: 'local_transport_required' });
    const remote = await app.inject({
      method: 'POST',
      url: '/context-source/read',
      remoteAddress: '198.51.100.7',
      payload: {
        adapter: 'knowledge-fabric',
        record: randomUUID(),
        revision: 'a'.repeat(64),
        digest: 'b'.repeat(64),
      },
    });
    expect(remote.statusCode).toBe(403);
  });
});
