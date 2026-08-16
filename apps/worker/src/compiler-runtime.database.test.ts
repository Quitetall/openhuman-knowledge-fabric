import { randomUUID } from 'node:crypto';
import { type ActionRequest } from '@kf/actions';
import { digestOf, InMemoryObjectStore } from '@kf/artifacts';
import { digest } from '@kf/canonicalization';
import { createPool, setAccessContext, withTransaction, type Pool } from '@kf/database';
import {
  createAuthoredFragmentRevision,
  createCompilationBasis,
  createCompositionRevision,
  createDocumentActionAtoms,
  verifyCompilationRunPreimage,
  type CompilerResponse,
  type DocumentCompilerAdapter,
} from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCompilationRuntime,
  createPostgresCompilerRuntimeRepository,
  type CompilerRuntimeRepository,
} from './compiler-runtime.js';
import {
  registerTestDocumentCompiler,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../../../tests/database/harness.js';

const REGISTERED_COMPILER = {
  name: 'synthetic-unqualified-liminal',
  version: 'test-only',
  protocol: 'kf-document-v1' as const,
  commitSha: '7'.repeat(40),
  cargoLockDigest: '8'.repeat(64),
  executableDigest: '9'.repeat(64),
  runtimeClosureDigest: 'a'.repeat(64),
  qualification: { state: 'not_run' as const, receiptDigest: null, ratified: false },
};

describe('compiler runtime database boundary', () => {
  let harness: Harness;
  let fixtures: Fixtures;
  let workerPool: Pool;
  let store: InMemoryObjectStore;
  let requestActionId: string;
  let unboundProvenanceRequestActionId: string;
  let sourceBytes: Buffer;
  let compilerRegistrationId: string;
  let postgresRepository: CompilerRuntimeRepository;
  let recordedArguments: Parameters<CompilerRuntimeRepository['persist']> | undefined;

  beforeAll(async () => {
    harness = await startHarness();
    fixtures = await seedFixtures(harness.adminPool);
    compilerRegistrationId = await registerTestDocumentCompiler(
      harness.adminPool,
      REGISTERED_COMPILER,
      fixtures.reviewerId,
    );
    store = new InMemoryObjectStore();
    sourceBytes = Buffer.from('# Runtime constitution\n');
    const sourceDigest = digestOf(sourceBytes);
    const sourceKey = `compiler-runtime-source/${sourceDigest}`;
    await store.put(sourceKey, sourceBytes, 'text/markdown');

    const execute = createFabricDispatcher(
      harness.pool,
      createDocumentActionAtoms({
        store,
        parser: {
          async parse() {
            return undefined;
          },
        },
      }),
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
        actorId: author ? fixtures.performerId : fixtures.reviewerId,
        actingRoleId: author ? fixtures.performerRoleId : fixtures.reviewerRoleId,
        targetIds,
        payload,
        idempotencyKey: `compiler-runtime-db-${actionType}-${sequence}`,
        requestId: `compiler-runtime-db-${sequence}`,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      } as ActionRequest);
    };

    const artifact = await call('attach_evidence', [], {
      title: 'runtime-constitution.md',
      artifact_kind: 'specification',
      sha256: sourceDigest,
      size_bytes: sourceBytes.length,
      media_type: 'text/markdown',
      storage_uri: sourceKey,
    });
    const artifactId = artifact.objectIds[0]!;
    const artifactVersionId = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
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
      title: 'Runtime constitution atom',
      stable_key: `runtime.constitution.${randomUUID()}`,
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
        title: 'Runtime constitution composition',
        stable_key: `runtime.constitution.composition.${randomUUID()}`,
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
    const compositionId = composition.objectIds[0]!;

    const fragmentRevision = createAuthoredFragmentRevision({
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
    });
    const compositionRevision = createCompositionRevision({
      id: compositionRevisionId,
      compositionId,
      previousRevisionId: null,
      classification: 'internal',
      inputs: [{ ordinal: 1, role: 'fragment', fragmentRevisionId }],
    });
    const basis = createCompilationBasis({
      protocol: 'kf-document-v1',
      rootCompositionRevisionId: compositionRevisionId,
      fragmentRevisions: [fragmentRevision],
      compositionRevisions: [compositionRevision],
      bindings: [],
      targetProfiles: [{ target: 'markdown', profileDigest: '4'.repeat(64) }],
      ontologyDigest: '5'.repeat(64),
      policyDigest: '6'.repeat(64),
      compiler: {
        kind: 'liminal',
        ...REGISTERED_COMPILER,
      },
    });
    const requested = await call('request_document_compilation', [compositionId], {
      basis_id: randomUUID(),
      basis,
    });
    requestActionId = requested.actionId;
    const unboundProvenanceBasis = createCompilationBasis({
      protocol: basis.protocol,
      rootCompositionRevisionId: basis.rootCompositionRevisionId,
      fragmentRevisions: basis.fragmentRevisions,
      compositionRevisions: basis.compositionRevisions,
      bindings: basis.bindings,
      targetProfiles: [{ target: 'markdown', profileDigest: 'b'.repeat(64) }],
      ontologyDigest: basis.ontologyDigest,
      policyDigest: basis.policyDigest,
      compiler: basis.compiler,
    });
    const unboundProvenanceRequest = await call('request_document_compilation', [compositionId], {
      basis_id: randomUUID(),
      basis: unboundProvenanceBasis,
    });
    unboundProvenanceRequestActionId = unboundProvenanceRequest.actionId;

    const login = `kf_worker_test_${randomUUID().replaceAll('-', '')}`;
    const password = 'test-only-not-a-secret';
    await withTransaction(harness.adminPool, async (tx) => {
      const sql = await tx.one<{ sql: string }>(
        "select format('create role %I login password %L inherit', $1::text, $2::text) as sql",
        [login, password],
      );
      await tx.query(sql.sql);
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
    postgresRepository = createPostgresCompilerRuntimeRepository(workerPool);
  }, 180_000);

  afterAll(async () => {
    await workerPool?.end();
    await harness?.stop();
  });

  it('keeps request loading worker-only and atomically records one replay-safe derived result', async () => {
    await expect(
      withTransaction(workerPool, async (tx) =>
        tx.query('insert into content.compilation_run (id) values ($1)', [randomUUID()]),
      ),
    ).rejects.toThrow(/permission denied.*compilation_run/i);
    await expect(
      withTransaction(workerPool, async (tx) =>
        tx.query('insert into content.compiled_view (id) values ($1)', [randomUUID()]),
      ),
    ).rejects.toThrow(/permission denied.*compiled_view/i);
    await expect(
      withTransaction(harness.pool, async (tx) =>
        tx.query('insert into content.document_compiler_registration (id) values ($1)', [
          randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/permission denied.*document_compiler_registration/i);

    await expect(
      withTransaction(harness.pool, async (tx) =>
        tx.query('select content.compiler_runtime_request($1)', [requestActionId]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTransaction(workerPool, async (tx) =>
        tx.one<{ active: boolean }>('select content.compiler_runtime_active() as active'),
      ),
    ).resolves.toEqual({ active: false });

    const loadedRequest = await postgresRepository.load(requestActionId);
    expect(loadedRequest.compilerRegistrationId).toBe(compilerRegistrationId);
    expect(loadedRequest.draftOnly).toBe(true);
    expect(loadedRequest.basis.compiler).toEqual({ kind: 'liminal', ...REGISTERED_COMPILER });
    const viewBytes = Buffer.from('# Compiled runtime constitution\n');
    const adapter: DocumentCompilerAdapter = {
      identity: loadedRequest.basis.compiler,
      compile: async (request): Promise<CompilerResponse> => {
        const semanticGraph = { kind: 'document', title: 'Runtime constitution' };
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
          hirProvenance: [{ nodeId: 'hir:runtime-constitution', ...provenance }],
          cirProvenance: [{ nodeId: 'cir:runtime-constitution', ...provenance }],
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
    };
    const recordingRepository: CompilerRuntimeRepository = {
      load: (actionId) => postgresRepository.load(actionId),
      persist: async (...args) => {
        recordedArguments = args;
        return postgresRepository.persist(...args);
      },
    };
    const runtime = createCompilationRuntime({
      repository: recordingRepository,
      store,
      adapterFor: () => adapter,
    });

    const first = await runtime.process(requestActionId);
    const replay = await runtime.process(requestActionId);
    expect(first).toMatchObject({ status: 'succeeded', replayed: false });
    expect(replay).toEqual({ runId: first.runId, status: 'succeeded', replayed: true });

    expect(recordedArguments).toBeDefined();
    const [recordedRequest, recordedRun, recordedViews] = recordedArguments!;
    await expect(
      postgresRepository.persist(
        recordedRequest,
        {
          ...recordedRun,
          diagnostics: [
            {
              severity: 'warning',
              code: 'forged_replay',
              message: 'Must not be accepted under an already-recorded run digest',
            },
          ],
        },
        recordedViews,
      ),
    ).rejects.toThrow(/idempotent compiler replay differs/i);

    const recorded = await withTransaction(harness.adminPool, async (tx) =>
      tx.one<{
        runs: string;
        views: string;
        artifacts: string;
        enterprise_ids: string;
        requested_by_action: string;
        compiler_registration_id: string;
        draft_only: boolean;
        projection_capabilities: unknown;
        preimages: string;
        canonical_preimage: string;
        semantic_preimage: string;
        semantic_graph: unknown;
      }>(
        `select
           (select count(*)::text from content.compilation_run
             where requested_by_action = $1) as runs,
           (select count(*)::text from content.compiled_view v
             join content.compilation_run r on r.id = v.compilation_run_id
            where r.requested_by_action = $1) as views,
           (select count(*)::text from content.compiled_view v
             join content.compilation_run r on r.id = v.compilation_run_id
             join content.artifact_version av on av.id = v.artifact_version_id
            where r.requested_by_action = $1) as artifacts,
           (select count(o.enterprise_id)::text from content.compiled_view v
             join content.compilation_run r on r.id = v.compilation_run_id
             join content.artifact_version av on av.id = v.artifact_version_id
             join core.object o on o.id = av.artifact_id
            where r.requested_by_action = $1) as enterprise_ids,
           (select requested_by_action::text from content.compilation_run
             where requested_by_action = $1) as requested_by_action,
           (select compiler_registration_id::text from content.compilation_run
             where requested_by_action = $1) as compiler_registration_id,
           (select draft_only from content.compilation_run
             where requested_by_action = $1) as draft_only,
           (select projection_capabilities from content.compilation_run
             where requested_by_action = $1) as projection_capabilities,
           (select count(*)::text from content.compilation_run_preimage p
             join content.compilation_run r on r.id = p.run_id
            where r.requested_by_action = $1) as preimages,
           (select p.canonical_preimage from content.compilation_run_preimage p
             join content.compilation_run r on r.id = p.run_id
            where r.requested_by_action = $1) as canonical_preimage,
           (select p.semantic_preimage from content.compilation_run_preimage p
             join content.compilation_run r on r.id = p.run_id
            where r.requested_by_action = $1) as semantic_preimage,
           (select p.semantic_graph from content.compilation_run_preimage p
             join content.compilation_run r on r.id = p.run_id
            where r.requested_by_action = $1) as semantic_graph`,
        [requestActionId],
      ),
    );
    expect(recorded).toMatchObject({
      runs: '1',
      views: '1',
      artifacts: '1',
      enterprise_ids: '0',
      requested_by_action: requestActionId,
      compiler_registration_id: compilerRegistrationId,
      draft_only: true,
      projection_capabilities: [{ target: 'markdown', capabilities: ['source_map'] }],
      preimages: '1',
      semantic_graph: { kind: 'document', title: 'Runtime constitution' },
    });
    expect(recorded.semantic_preimage).toBe('{"kind":"document","title":"Runtime constitution"}');
    expect(
      verifyCompilationRunPreimage(recorded.canonical_preimage, recordedRun.runDigest),
    ).toMatchObject({ semanticGraph: recorded.semantic_graph });
  });

  it('accepts multiple IR nodes from one source when full compiler claim identities differ', async () => {
    const result = await withTransaction(harness.adminPool, async (tx) => {
      const source = await tx.one<{
        basis_id: string;
        source_id: string;
        source_digest: string;
      }>(
        `select basis.id as basis_id, revision.id as source_id,
                revision.content_digest as source_digest
           from core.action action
           join content.compilation_basis basis
             on basis.id = (action.parameters ->> 'basis_id')::uuid
           join content.compilation_basis_fragment member on member.basis_id = basis.id
           join content.authored_fragment_revision revision
             on revision.id = member.fragment_revision_id
          where action.id = $1`,
        [requestActionId],
      );
      const claim = {
        sourceKind: 'fragment',
        sourceId: source.source_id,
        sourceDigest: source.source_digest,
      };
      const distinctNodes = [
        { nodeId: 'hir:title', sourcePath: '/title', ...claim },
        { nodeId: 'hir:body', sourcePath: '/body', ...claim },
      ];
      const exactDuplicate = [distinctNodes[0], distinctNodes[0]];
      const extraField = [{ ...distinctNodes[0], undocumented: true }];
      return tx.one<{ distinct_nodes: boolean; exact_duplicate: boolean; extra_field: boolean }>(
        `select content.compilation_provenance_covers_basis($1, $2::jsonb) as distinct_nodes,
                content.compilation_provenance_covers_basis($1, $3::jsonb) as exact_duplicate,
                content.compilation_provenance_covers_basis($1, $4::jsonb) as extra_field`,
        [
          source.basis_id,
          JSON.stringify(distinctNodes),
          JSON.stringify(exactDuplicate),
          JSON.stringify(extraField),
        ],
      );
    });
    expect(result).toEqual({ distinct_nodes: true, exact_duplicate: false, extra_field: false });
  });

  it('rejects malformed result scalars and evidence elements before replay comparison', async () => {
    expect(recordedArguments).toBeDefined();
    const [recordedRequest, validRun, recordedViews] = recordedArguments!;
    const provenance = {
      nodeId: 'hir:title',
      sourceKind: 'fragment',
      sourceId: 'fragment-revision-1',
      sourcePath: null,
      sourceDigest: 'a'.repeat(64),
    };
    const malformedRuns: ReadonlyArray<readonly [string, unknown]> = [
      ['non-string compiler digest', { ...validRun, compilerDigest: 7 }],
      ['uppercase run digest', { ...validRun, runDigest: 'A'.repeat(64) }],
      [
        'extra HIR provenance field',
        { ...validRun, hirProvenance: [{ ...provenance, undocumented: true }] },
      ],
      [
        'invalid CIR provenance digest',
        { ...validRun, cirProvenance: [{ ...provenance, sourceDigest: 'not-a-digest' }] },
      ],
      [
        'non-string unresolved-reference source node',
        {
          ...validRun,
          unresolvedReferences: [
            {
              sourceNodeId: 42,
              reference: 'KF-MISSING',
              reasonCode: 'missing',
              message: 'Missing',
            },
          ],
        },
      ],
      [
        'missing omitted-subgraph message',
        {
          ...validRun,
          omittedSubgraphs: [{ rootNodeId: 'cir:omitted', reasonCode: 'projection_policy' }],
        },
      ],
      [
        'non-string projection capability',
        {
          ...validRun,
          projectionCapabilities: [{ target: 'markdown', capabilities: ['source_map', 17] }],
        },
      ],
      [
        'extra projection-capability field',
        {
          ...validRun,
          projectionCapabilities: [
            { target: 'markdown', capabilities: ['source_map'], undocumented: true },
          ],
        },
      ],
      [
        'invalid diagnostic severity and extra field',
        {
          ...validRun,
          diagnostics: [{ severity: 'trace', code: 'trace', message: 'Trace', undocumented: true }],
        },
      ],
      [
        'non-string conversion-loss path',
        {
          ...validRun,
          conversionLoss: [{ code: 'loss', path: 4, message: 'Loss' }],
        },
      ],
    ];

    for (const [label, malformedRun] of malformedRuns) {
      await expect(
        postgresRepository.persist(recordedRequest, malformedRun as typeof validRun, recordedViews),
        label,
      ).rejects.toThrow(/malformed|invalid fields/i);
    }
  });

  it('rejects well-shaped HIR and CIR provenance not pinned by exact Basis identity and digest', async () => {
    expect(recordedArguments).toBeDefined();
    const [, validRun, recordedViews] = recordedArguments!;
    const unrecordedRequest = await postgresRepository.load(unboundProvenanceRequestActionId);
    const fragment = unrecordedRequest.basis.fragmentRevisions[0]!;
    const basisClaim = {
      nodeId: 'hir:title',
      sourceKind: 'fragment' as const,
      sourceId: fragment.id,
      sourcePath: null,
      sourceDigest: fragment.holder.contentDigest,
    };
    const unboundClaims = [
      { ...basisClaim, sourceId: randomUUID() },
      { ...basisClaim, sourceDigest: '0'.repeat(64) },
    ];

    for (const claim of unboundClaims) {
      await expect(
        postgresRepository.persist(
          unrecordedRequest,
          {
            ...validRun,
            id: randomUUID(),
            // No `basisId` on the run: a `CompilationRun` does not carry one. `persist`
            // reads `request.basisId` (postgres-repository.ts:76), so this property never
            // reached the payload — it read as though the test were binding the run to a
            // basis when the request argument was already doing exactly that.
            basisDigest: unrecordedRequest.basis.basisDigest,
            hirProvenance: [claim],
            runDigest: digest({ invalidBasisClaim: claim }),
          },
          recordedViews.map((view) => ({
            ...view,
            id: randomUUID(),
            artifactId: randomUUID(),
            artifactVersionId: randomUUID(),
          })),
        ),
      ).rejects.toThrow(/not pinned by exact Basis digest/i);
    }
  });

  it('keeps compiler registry backup access SELECT-only under FORCE RLS policies', async () => {
    const tables = await withTransaction(harness.adminPool, async (tx) =>
      tx.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        backup_select: boolean;
        backup_insert: boolean;
      }>(
        `select relation.relname,
                relation.relrowsecurity,
                relation.relforcerowsecurity,
                has_table_privilege(
                  'kf_backup', format('content.%I', relation.relname), 'SELECT'
                ) as backup_select,
                has_table_privilege(
                  'kf_backup', format('content.%I', relation.relname), 'INSERT'
                ) as backup_insert
           from pg_class relation
           join pg_namespace namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = 'content'
            and relation.relname = any(array[
              'document_compiler_registration', 'document_compiler_revocation'
            ])
          order by relation.relname`,
      ),
    );
    expect(tables).toEqual([
      {
        relname: 'document_compiler_registration',
        relrowsecurity: true,
        relforcerowsecurity: true,
        backup_select: true,
        backup_insert: false,
      },
      {
        relname: 'document_compiler_revocation',
        relrowsecurity: true,
        relforcerowsecurity: true,
        backup_select: true,
        backup_insert: false,
      },
    ]);

    const policies = await withTransaction(harness.adminPool, async (tx) =>
      tx.query<{ tablename: string; policyname: string; cmd: string; qual: string }>(
        `select tablename, policyname, cmd, qual
           from pg_policies
          where schemaname = 'content'
            and tablename = any(array[
              'document_compiler_registration', 'document_compiler_revocation'
            ])
            and roles = array['kf_backup']::name[]
          order by tablename, policyname`,
      ),
    );
    expect(policies).toEqual([
      {
        tablename: 'document_compiler_registration',
        policyname: 'document_compiler_registration_backup',
        cmd: 'SELECT',
        qual: 'true',
      },
      {
        tablename: 'document_compiler_revocation',
        policyname: 'document_compiler_revocation_backup',
        cmd: 'SELECT',
        qual: 'true',
      },
    ]);
  });

  it('lets a non-superuser migration authority register, read, revoke, and serve definer reads', async () => {
    const login = `kf_migrator_test_${randomUUID().replaceAll('-', '')}`;
    const password = 'test-only-not-a-secret';
    const registrationId = randomUUID();
    await withTransaction(harness.adminPool, async (tx) => {
      const createRole = await tx.one<{ sql: string }>(
        "select format('create role %I login password %L inherit', $1::text, $2::text) as sql",
        [login, password],
      );
      await tx.query(createRole.sql);
      const grantRole = await tx.one<{ sql: string }>(
        "select format('grant kf_migrator to %I', $1::text) as sql",
        [login],
      );
      await tx.query(grantRole.sql);
      await tx.query(
        `create function content.test_compiler_registry_definer_probe(p_registration_id uuid)
           returns jsonb
           language sql
           security definer
           set search_path = pg_catalog, content
           as $$
             select jsonb_build_object(
               'registrations', (
                 select count(*) from content.document_compiler_registration
                  where id = p_registration_id
               ),
               'revocations', (
                 select count(*) from content.document_compiler_revocation
                  where registration_id = p_registration_id
               )
             )
           $$`,
      );
      const alterOwner = await tx.one<{ sql: string }>(
        "select format('alter function content.test_compiler_registry_definer_probe(uuid) owner to %I', $1::text) as sql",
        [login],
      );
      await tx.query(alterOwner.sql);
      await tx.query(
        'grant execute on function content.test_compiler_registry_definer_probe(uuid) to kf_app',
      );
    });

    const uri = new URL(harness.connectionString);
    uri.username = login;
    uri.password = password;
    const migratorPool = createPool({ connectionString: uri.toString(), maxConnections: 1 });
    try {
      const role = await withTransaction(migratorPool, async (tx) =>
        tx.one<{ superuser: boolean; bypassrls: boolean }>(
          `select rolsuper as superuser, rolbypassrls as bypassrls
             from pg_roles where rolname = current_user`,
        ),
      );
      expect(role).toEqual({ superuser: false, bypassrls: false });

      await withTransaction(migratorPool, async (tx) => {
        await tx.query(
          `insert into content.document_compiler_registration
             (id, compiler_name, compiler_version, protocol, liminal_commit_sha,
              cargo_lock_digest, executable_digest, runtime_closure_digest,
              qualification_state, qualification_receipt_digest,
              qualification_ratified, registered_by)
           values ($1, $2, 'test-only', 'kf-document-v1', $3, $4, $5, $6,
                   'not_run', null, false, $7)`,
          [
            registrationId,
            `non-superuser-authority-${randomUUID()}`,
            'a'.repeat(40),
            'b'.repeat(64),
            'c'.repeat(64),
            'd'.repeat(64),
            fixtures.reviewerId,
          ],
        );
        expect(
          await tx.one<{ count: string }>(
            `select count(*)::text as count
               from content.document_compiler_registration where id = $1`,
            [registrationId],
          ),
        ).toEqual({ count: '1' });
        await tx.query(
          `insert into content.document_compiler_revocation
             (registration_id, revoked_by, revocation_reason)
           values ($1, $2, 'non-superuser authority test')`,
          [registrationId, fixtures.reviewerId],
        );
        expect(
          await tx.one<{ count: string }>(
            `select count(*)::text as count
               from content.document_compiler_revocation where registration_id = $1`,
            [registrationId],
          ),
        ).toEqual({ count: '1' });
      });

      const definerRead = await withTransaction(harness.pool, async (tx) =>
        tx.one<{ result: { registrations: number; revocations: number } }>(
          'select content.test_compiler_registry_definer_probe($1) as result',
          [registrationId],
        ),
      );
      expect(definerRead.result).toEqual({ registrations: 1, revocations: 1 });
    } finally {
      await migratorPool.end();
      await withTransaction(harness.adminPool, async (tx) => {
        await tx.query(
          'drop function if exists content.test_compiler_registry_definer_probe(uuid)',
        );
        const dropRole = await tx.one<{ sql: string }>(
          "select format('drop role if exists %I', $1::text) as sql",
          [login],
        );
        await tx.query(dropRole.sql);
      });
    }
  });

  it('serializes concurrent owner registration of the same enabled compiler pin', async () => {
    const pin = {
      ...REGISTERED_COMPILER,
      name: `concurrent-${randomUUID()}`,
    };
    const attempts = await Promise.allSettled([
      registerTestDocumentCompiler(harness.adminPool, pin, fixtures.reviewerId),
      registerTestDocumentCompiler(
        harness.adminPool,
        {
          ...pin,
          qualification: { state: 'incomplete', receiptDigest: null, ratified: false },
        },
        fixtures.reviewerId,
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected).toBeDefined();
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
      /enabled registration already exists/i,
    );
  });

  it('leaves no application document INSERT or Holder UPDATE grant without an exact guard', async () => {
    const unguarded = await withTransaction(harness.adminPool, async (tx) =>
      tx.query<{ table_name: string }>(
        `select grants.table_name
           from information_schema.role_table_grants grants
          where grants.grantee = 'kf_app'
            and grants.table_schema = 'content'
            and grants.privilege_type = 'INSERT'
            and grants.table_name = any(array[
              'document_subject', 'document_source_holder', 'authored_fragment',
              'authored_fragment_revision', 'document_composition', 'composition_revision',
              'composition_input', 'typed_binding', 'compilation_basis',
              'compilation_basis_fragment', 'compilation_basis_composition',
              'compilation_basis_binding', 'compilation_run', 'compiled_view',
              'proposal_overlay', 'document_publication'
            ])
            and not exists (
              select 1
                from pg_trigger trigger
                join pg_class relation on relation.oid = trigger.tgrelid
                join pg_namespace namespace on namespace.oid = relation.relnamespace
                join pg_proc procedure on procedure.oid = trigger.tgfoid
               where namespace.nspname = grants.table_schema
                 and relation.relname = grants.table_name
                 and not trigger.tgisinternal
                 and procedure.proname = 'enforce_document_typed_insert'
            )
          order by grants.table_name`,
      ),
    );
    expect(unguarded).toEqual([]);

    const privileges = await withTransaction(harness.adminPool, async (tx) =>
      tx.one<{
        worker_run_insert: boolean;
        worker_view_insert: boolean;
        app_binding_insert: boolean;
        app_holder_update: boolean;
        holder_update_guard: boolean;
      }>(
        `select has_table_privilege('kf_worker', 'content.compilation_run', 'INSERT')
                  as worker_run_insert,
                has_table_privilege('kf_worker', 'content.compiled_view', 'INSERT')
                  as worker_view_insert,
                has_table_privilege('kf_app', 'content.typed_binding', 'INSERT')
                  as app_binding_insert,
                has_column_privilege(
                  'kf_app', 'content.document_subject', 'current_holder_id', 'UPDATE'
                ) as app_holder_update,
                exists (
                  select 1 from pg_trigger
                   where tgrelid = 'content.document_subject'::regclass
                     and tgname = 'document_subject_guard_0_holder_update'
                     and not tgisinternal
                ) as holder_update_guard`,
      ),
    );
    expect(privileges).toEqual({
      worker_run_insert: false,
      worker_view_insert: false,
      app_binding_insert: false,
      app_holder_update: true,
      holder_update_guard: true,
    });
  });
});
