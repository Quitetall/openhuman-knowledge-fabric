/**
 * The views a refused compilation materialized are collected, and nothing referenced is (SAS
 * §100.64, KF-SAS-RQ-094, RQ-102; 20261011210000).
 *
 * One real PostgreSQL and one in-memory store the compiler runtime writes to:
 *
 *   1. a compilation succeeds with view X; the same pinned binary, requalified, compiles the same
 *      sources to Y and the database refuses it (KF-DOC-DETERMINISM-001) — Y's bytes stay in the
 *      store, named by nothing. `kf-storage --collect-orphans` removes Y, records it in
 *      `content.orphan_collection` with the digest its key names, and keeps X;
 *   2. a view the sweep collects while a run that adopted it is compiling is not recorded: the
 *      run re-reads its bytes under the sweep's lock, finds them gone, and is retried, writing
 *      the view again — so no receipt ever names bytes that are not there;
 *   3. the reference check sees every organization: a view another organization's run recorded
 *      is kept, though the collector's row security cannot see that run; and only a service
 *      actor may ask, only about a compiled view's content address.
 */

import { randomUUID } from 'node:crypto';
import { type ActionRequest } from '@kf/actions';
import { digestOf, InMemoryObjectStore } from '@kf/artifacts';
import { digest } from '@kf/canonicalization';
import { bindPrincipal, createPool, withTransaction, type Pool } from '@kf/database';
import {
  createAuthoredFragmentRevision,
  createCompilationBasis,
  createCompositionRevision,
  createDocumentActionAtoms,
  type CompilationBasis,
  type CompilerResponse,
  type DocumentCompilerAdapter,
} from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDeclareServiceActor } from '../../apps/api/src/admin/declare-service-actor.js';
import {
  COMPILED_VIEW_PREFIX,
  sweepUnreferencedCompiledViews,
} from '../../apps/kf-storage/src/orphans.js';
import {
  CompiledViewCollected,
  createCompilationRuntime,
  createPostgresCompilerRuntimeRepository,
  type CompilerRuntimeRepository,
} from '../../apps/worker/src/compiler-runtime.js';
import {
  aYearFromNow,
  bindContext,
  createObject,
  registerTestDocumentCompiler,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

const PIN = {
  name: 'synthetic-collection-liminal',
  version: 'test-only',
  protocol: 'kf-document-v1' as const,
  commitSha: 'c'.repeat(40),
  cargoLockDigest: 'd'.repeat(64),
  executableDigest: 'e'.repeat(64),
  runtimeClosureDigest: 'f'.repeat(64),
};

type Qualification = {
  readonly state: 'not_run' | 'incomplete' | 'unratified';
  readonly receiptDigest: null;
  readonly ratified: false;
};

const qualified = (state: Qualification['state']): Qualification => ({
  state,
  receiptDigest: null,
  ratified: false,
});

type Execute = ReturnType<typeof createFabricDispatcher>;

/** Far enough ahead that every key in the store is past the 168-hour grace period. */
const LATER = (): Date => new Date(Date.now() + 200 * 3_600_000);

const viewKey = (text: string): string => `${COMPILED_VIEW_PREFIX}${digestOf(Buffer.from(text))}`;

describe("a refused compilation's views are collected (SAS §100.64)", () => {
  let harness: Harness;
  let fixtures: Fixtures;
  let workerPool: Pool;
  let store: InMemoryObjectStore;
  let repository: CompilerRuntimeRepository;
  let compositionId: string;
  let sources: Omit<Parameters<typeof createCompilationBasis>[0], 'compiler'>;
  let steward: {
    personId: string;
    roleAssignmentId: string;
    organizationId: string;
    maxClassification: string;
  };
  let call: (
    actionType: string,
    targetIds: readonly string[],
    payload: Readonly<Record<string, unknown>>,
    author?: boolean,
    via?: Execute,
  ) => Promise<{ readonly actionId: string; readonly objectIds: readonly string[] }>;

  beforeAll(async () => {
    harness = await startHarness();
    fixtures = await seedFixtures(harness.adminPool);
    store = new InMemoryObjectStore();
    const sourceBytes = Buffer.from('# Reproduced constitution\n');
    const sourceDigest = digestOf(sourceBytes);
    const sourceKey = `ingest/${fixtures.organizationId}/${sourceDigest}`;
    await store.put(sourceKey, sourceBytes, 'text/markdown');

    const atoms = createDocumentActionAtoms({
      store,
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const execute = createFabricDispatcher(harness.pool, atoms);
    let sequence = 0;
    call = (actionType, targetIds, payload, author = false, via = execute) => {
      sequence += 1;
      return via({
        actionType,
        actorId: author ? fixtures.performerId : fixtures.reviewerId,
        actingRoleId: author ? fixtures.performerRoleId : fixtures.reviewerRoleId,
        targetIds,
        payload,
        idempotencyKey: `compiler-reproduction-${actionType}-${sequence}`,
        requestId: `compiler-reproduction-${sequence}`,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      } as ActionRequest);
    };

    const artifact = await call('attach_evidence', [], {
      title: 'reproduced-constitution.md',
      artifact_kind: 'document',
      sha256: sourceDigest,
      size_bytes: sourceBytes.length,
      media_type: 'text/markdown',
      storage_uri: sourceKey,
    });
    const artifactId = artifact.objectIds[0]!;
    const artifactVersionId = await withTransaction(harness.pool, async (tx) => {
      await bindPrincipal(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return (
        await tx.one<{ id: string }>(
          'select id from content.artifact_version where artifact_id = $1',
          [artifactId],
        )
      ).id;
    });

    const fragmentRevisionId = randomUUID();
    const fragment = await call('add_authored_fragment', [], {
      title: 'Reproduced constitution atom',
      stable_key: `reproduction.constitution.${randomUUID()}`,
      holder_id: randomUUID(),
      holder: {
        kind: 'fabric_native',
        artifact_version_id: artifactVersionId,
        content_digest: sourceDigest,
      },
      revision_id: fragmentRevisionId,
      media_type: 'text/markdown',
      classification: 'internal',
      document_policy: 'ordinary',
    });
    const fragmentId = fragment.objectIds[0]!;
    const compositionRevisionId = randomUUID();
    const composition = await call(
      'add_document_composition',
      [],
      {
        title: 'Reproduced constitution composition',
        stable_key: `reproduction.constitution.composition.${randomUUID()}`,
        holder_id: randomUUID(),
        holder: {
          kind: 'fabric_native',
          artifact_version_id: artifactVersionId,
          content_digest: sourceDigest,
        },
        revision_id: compositionRevisionId,
        classification: 'internal',
        document_policy: 'ordinary',
        inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: fragmentRevisionId }],
      },
      true,
    );
    compositionId = composition.objectIds[0]!;
    sources = {
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
            contentDigest: sourceDigest,
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
    };

    const login = `kf_worker_test_${randomUUID().replaceAll('-', '')}`;
    const password = 'test-only-not-a-secret';
    await withTransaction(harness.adminPool, async (tx) => {
      const create = await tx.one<{ sql: string }>(
        "select format('create role %I login password %L inherit', $1::text, $2::text) as sql",
        [login, password],
      );
      await tx.query(create.sql);
      const grant = await tx.one<{ sql: string }>(
        "select format('grant kf_worker to %I', $1::text) as sql",
        [login],
      );
      await tx.query(grant.sql);
    });
    const uri = new URL(harness.connectionString);
    uri.username = login;
    uri.password = password;
    workerPool = createPool({ connectionString: uri.toString(), maxConnections: 4 });
    repository = createPostgresCompilerRuntimeRepository(workerPool);

    const declared = await runDeclareServiceActor(harness.adminPool, {
      validTo: aYearFromNow(),
      organizationId: fixtures.organizationId,
      name: 'compiled-view-steward',
      roleId: 'performer',
      classification: 'restricted',
      declaredBy: fixtures.reviewerId,
      reason: 'collects the compiled views refused compilations leave unreferenced',
    });
    steward = {
      personId: declared.personId,
      roleAssignmentId: declared.roleAssignmentId,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
    };
  }, 180_000);

  afterAll(async () => {
    await workerPool?.end();
    await harness?.stop();
  });

  function producing(viewText: string): (basis: CompilationBasis) => DocumentCompilerAdapter {
    return (basis) => ({
      identity: basis.compiler,
      compile: async (request): Promise<CompilerResponse> => {
        const viewBytes = Buffer.from(viewText);
        const semanticGraph = { kind: 'document', title: viewText };
        const fragment = request.basis.fragmentRevisions[0]!;
        const provenance = {
          sourceKind: 'fragment' as const,
          sourceId: fragment.id,
          sourcePath: null,
          sourceDigest: fragment.holder.contentDigest,
        };
        return {
          protocol: 'kf-document-v1',
          basisDigest: request.basisDigest,
          dependencyDigest: request.dependencyDigest,
          semanticGraph,
          semanticDigest: digest(semanticGraph),
          hirProvenance: [{ nodeId: 'hir:reproduction', ...provenance }],
          cirProvenance: [{ nodeId: 'cir:reproduction', ...provenance }],
          unresolvedReferences: [],
          omittedSubgraphs: [],
          projectionCapabilities: [{ target: 'markdown', capabilities: ['source_map'] }],
          diagnostics: [],
          conversionLoss: [],
          views: [
            {
              target: 'markdown',
              mediaType: 'text/markdown',
              bytesBase64: viewBytes.toString('base64'),
              contentDigest: digestOf(viewBytes),
            },
          ],
        };
      },
    });
  }

  async function registerPin(
    qualification: Qualification,
    revoke?: string,
    pin: typeof PIN = PIN,
  ): Promise<{ registrationId: string; basis: CompilationBasis }> {
    if (revoke !== undefined) {
      await withTransaction(harness.adminPool, (tx) =>
        tx.query(
          `insert into content.document_compiler_revocation
             (registration_id, revoked_by, revocation_reason)
           values ($1, $2, 'the same pinned binary is re-registered with a new qualification')`,
          [revoke, fixtures.reviewerId],
        ),
      );
    }
    const identity = { ...pin, qualification };
    const registrationId = await registerTestDocumentCompiler(
      harness.adminPool,
      identity,
      fixtures.reviewerId,
    );
    return {
      registrationId,
      basis: createCompilationBasis({ ...sources, compiler: { kind: 'liminal', ...identity } }),
    };
  }

  function runtimeFor(
    basis: CompilationBasis,
    viewText: string,
    beforePersist?: () => Promise<void>,
  ): ReturnType<typeof createCompilationRuntime> {
    const adapter = producing(viewText)(basis);
    return createCompilationRuntime({
      repository: {
        load: (actionId) => repository.load(actionId),
        persist: async (...args) => {
          await beforePersist?.();
          return repository.persist(...args);
        },
      },
      store,
      adapterFor: () => adapter,
    });
  }

  async function request(basis: CompilationBasis): Promise<string> {
    const requested = await call('request_document_compilation', [compositionId], {
      basis_id: randomUUID(),
      basis,
    });
    return requested.actionId;
  }

  async function compile(
    basis: CompilationBasis,
    viewText: string,
  ): Promise<{ runId: string; status: string }> {
    return runtimeFor(basis, viewText).process(await request(basis));
  }

  async function referenced(key: string): Promise<boolean> {
    return withTransaction(
      harness.adminPool,
      async (tx) =>
        (
          await tx.one<{ referenced: boolean }>(
            'select exists (select 1 from content.artifact_version where storage_uri = $1) as referenced',
            [key],
          )
        ).referenced,
    );
  }

  async function storedKeys(): Promise<string[]> {
    const keys: string[] = [];
    for await (const object of store.list(COMPILED_VIEW_PREFIX)) keys.push(object.key);
    return keys.sort();
  }

  it('removes what a refused run left, keeps what runs recorded, and records each removal', async () => {
    const a = await registerPin(qualified('not_run'));
    const kept = `# Recorded ${randomUUID()}\n`;
    const first = await compile(a.basis, kept);
    expect(first.status).toBe('succeeded');

    const b = await registerPin(qualified('incomplete'), a.registrationId);
    const refusedText = `# Not reproduced ${randomUUID()}\n`;
    const second = await compile(b.basis, refusedText);
    expect(second.status).toBe('failed');
    expect(await storedKeys()).toContain(viewKey(refusedText));
    expect(await referenced(viewKey(refusedText))).toBe(false);
    expect(await referenced(viewKey(kept))).toBe(true);

    // Inside the grace period nothing is collected, however unreferenced.
    const young = await sweepUnreferencedCompiledViews(harness.storagePool, store, steward, {
      graceHours: 168,
    });
    expect(young.collected).toEqual([]);

    const report = await sweepUnreferencedCompiledViews(harness.storagePool, store, steward, {
      graceHours: 168,
      now: LATER(),
    });
    expect(report.refused).toEqual([]);
    expect(report.collected).toEqual([viewKey(refusedText)]);
    expect(await storedKeys()).toEqual([viewKey(kept)]);

    const recorded = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{
        storage_key: string;
        sha256: string;
        versions_removed: number;
        collected_by: string;
        organization_id: string;
      }>(
        `select storage_key, sha256, versions_removed, collected_by, organization_id
           from content.orphan_collection where storage_key like 'compiled-views/%'`,
      ),
    );
    expect(recorded).toEqual([
      {
        storage_key: viewKey(refusedText),
        sha256: digestOf(Buffer.from(refusedText)),
        versions_removed: 1,
        collected_by: steward.personId,
        organization_id: fixtures.organizationId,
      },
    ]);

    // The recorded run's view is untouched, at the version its receipt names.
    const keptVersion = await withTransaction(harness.adminPool, async (tx) => {
      const row = await tx.one<{ storage_version: string }>(
        'select storage_version from content.artifact_version where storage_uri = $1',
        [viewKey(kept)],
      );
      return row.storage_version;
    });
    expect((await store.read(viewKey(kept), keptVersion, 1_048_576)).toString()).toBe(kept);

    // A second run finds nothing more to do.
    const again = await sweepUnreferencedCompiledViews(harness.storagePool, store, steward, {
      graceHours: 168,
      now: LATER(),
    });
    expect(again.collected).toEqual([]);
  });

  it('does not record a view the sweep collected while its run compiled; the retry writes it again', async () => {
    // A refused run leaves view T unreferenced.
    const pin = { ...PIN, executableDigest: '8'.repeat(64) };
    const a = await registerPin(qualified('not_run'), undefined, pin);
    expect((await compile(a.basis, `# First ${randomUUID()}\n`)).status).toBe('succeeded');
    const b = await registerPin(qualified('incomplete'), a.registrationId, pin);
    const adopted = `# Adopted ${randomUUID()}\n`;
    expect((await compile(b.basis, adopted)).status).toBe('failed');

    // Another binary's first compilation produces T: the runtime adopts the existing key. The
    // sweep collects that key between the run's materialization and its record.
    const other = { ...PIN, executableDigest: '9'.repeat(64) };
    const c = await registerPin(qualified('not_run'), undefined, other);
    const actionId = await request(c.basis);
    let swept: readonly string[] = [];
    const racing = runtimeFor(c.basis, adopted, async () => {
      if (swept.length > 0) return;
      const report = await sweepUnreferencedCompiledViews(harness.storagePool, store, steward, {
        graceHours: 168,
        now: LATER(),
      });
      swept = report.collected;
    });
    await expect(racing.process(actionId)).rejects.toThrow(CompiledViewCollected);
    expect(swept).toContain(viewKey(adopted));
    expect(await storedKeys()).not.toContain(viewKey(adopted));
    const nothing = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ n: number }>(
        'select count(*)::int as n from content.compilation_run where requested_by_action = $1',
        [actionId],
      ),
    );
    expect(nothing.n, 'a run naming collected bytes was recorded').toBe(0);

    // The retry: the same request, compiled again, writes the view again and records it.
    const retried = await racing.process(actionId);
    expect(retried.status).toBe('succeeded');
    expect(await storedKeys()).toContain(viewKey(adopted));
    expect(await referenced(viewKey(adopted))).toBe(true);
    const version = await withTransaction(
      harness.adminPool,
      async (tx) =>
        (
          await tx.one<{ storage_version: string }>(
            'select storage_version from content.artifact_version where storage_uri = $1',
            [viewKey(adopted)],
          )
        ).storage_version,
    );
    const bytes = await store.read(viewKey(adopted), version, 1_048_576);
    expect(bytes.toString()).toBe(adopted);
  });

  it('keeps a view another organization recorded, and answers only a service actor about a view', async () => {
    // A recorded version in ANOTHER organization names this key. The steward's row security
    // cannot see it; the definer check does.
    const text = `# Elsewhere ${randomUUID()}\n`;
    const key = viewKey(text);
    await store.put(key, Buffer.from(text), 'text/markdown');
    const elsewhere = await seedFixtures(harness.adminPool);
    const artifactId = await createObject(harness.adminPool, elsewhere, {
      type: 'artifact',
      domain: 'artifact',
      state: 'draft',
      title: 'Another organization’s compiled view',
      createdBy: elsewhere.reviewerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, elsewhere, elsewhere.reviewerId);
      await tx.query(
        `insert into content.artifact (id, artifact_kind, source_system)
         values ($1, 'document', 'object_store')`,
        [artifactId],
      );
      await tx.query(
        `insert into content.artifact_version
           (id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
            storage_uri, storage_version, created_by, created_by_action)
         values ($1, $2, 1, 'R01', $3, $4, 'text/markdown', $5, 'v-elsewhere', $6, $7)`,
        [
          randomUUID(),
          artifactId,
          digestOf(Buffer.from(text)),
          Buffer.byteLength(text),
          key,
          elsewhere.reviewerId,
          elsewhere.clearanceActionId,
        ],
      );
    });
    const visibleToSteward = await withTransaction(harness.storagePool, async (tx) => {
      await bindPrincipal(tx, {
        actorId: steward.personId,
        actingRoleId: steward.roleAssignmentId,
        organizationId: steward.organizationId,
        maxClassification: steward.maxClassification,
      });
      return (
        await tx.one<{ n: number }>(
          'select count(*)::int as n from content.artifact_version where storage_uri = $1',
          [key],
        )
      ).n;
    });
    expect(visibleToSteward, 'the steward could see the other organization’s version').toBe(0);

    const report = await sweepUnreferencedCompiledViews(harness.storagePool, store, steward, {
      graceHours: 168,
      now: LATER(),
    });
    expect(report.collected).not.toContain(key);
    expect(await storedKeys()).toContain(key);

    // A human is not a collector, and the claim answers only about a compiled view's address.
    await expect(
      withTransaction(harness.pool, async (tx) => {
        await bindPrincipal(tx, {
          actorId: fixtures.reviewerId,
          actingRoleId: fixtures.reviewerRoleId,
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        await tx.query('select content.claim_unreferenced_compiled_view($1)', [key]);
      }),
    ).rejects.toThrow(/service actor/);
    await expect(
      withTransaction(harness.storagePool, async (tx) => {
        await bindPrincipal(tx, {
          actorId: steward.personId,
          actingRoleId: steward.roleAssignmentId,
          organizationId: steward.organizationId,
          maxClassification: steward.maxClassification,
        });
        await tx.query('select content.claim_unreferenced_compiled_view($1)', [
          `ingest/${fixtures.organizationId}/${'a'.repeat(64)}`,
        ]);
      }),
    ).rejects.toThrow(/content address/);
    // Nor is a referenced view recorded as collected, whoever asks.
    await expect(
      withTransaction(harness.storagePool, async (tx) => {
        await bindPrincipal(tx, {
          actorId: steward.personId,
          actingRoleId: steward.roleAssignmentId,
          organizationId: steward.organizationId,
          maxClassification: steward.maxClassification,
        });
        await tx.query("select content.record_orphan_collection('working', $1, 1, $2)", [
          key,
          'a referenced view claimed as an orphan',
        ]);
      }),
    ).rejects.toThrow(/is referenced/);
  });
});
