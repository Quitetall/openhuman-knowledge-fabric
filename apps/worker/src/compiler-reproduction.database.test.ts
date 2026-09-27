/**
 * A compilation of the same sources by the same pinned compiler reproduces the earlier one
 * (KF-SAS-RQ-102, migration 20260925160100, ADR 0002 note of 2026-09-25).
 *
 * The exact case cannot arise: an identical Basis is refused by `basis_digest`'s uniqueness. The
 * case that can is the one this file builds — the same pinned binary re-registered with a new
 * qualification, which makes a new Basis over the same sources. Three runs, one real PostgreSQL:
 *
 *   1. registration A (`not_run`) compiles the sources to X — succeeded;
 *   2. A revoked, B (`incomplete`) registered for the same binary, the same sources compile to
 *      Y — the database refuses to record it as a success (KF-DOC-DETERMINISM-001), and the
 *      worker records a failed run `nondeterministic_output` naming run 1 instead;
 *   3. B revoked, C (`unratified`) registered, the same sources compile to X again — succeeded.
 *
 * And acceptance reads that record (migration 20260925170000): once a run over the same sources
 * and pinned compiler failed as `nondeterministic_output`, no succeeded run of theirs is accepted
 * (KF-DOC-DETERMINISM-002) — not the run it named, and not a later one that happens to reproduce
 * it — by the precondition and, with the precondition removed, by the database. A run with no
 * failed reproduction, and a different binary over the same sources, are still accepted.
 *
 * Not covered: a compiler that is nondeterministic only between two runs nobody asked for.
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

const PIN = {
  name: 'synthetic-reproduction-liminal',
  version: 'test-only',
  protocol: 'kf-document-v1' as const,
  commitSha: 'c'.repeat(40),
  cargoLockDigest: 'd'.repeat(64),
  executableDigest: 'e'.repeat(64),
  runtimeClosureDigest: 'f'.repeat(64),
};

type Qualification =
  | {
      readonly state: 'not_run' | 'incomplete' | 'unratified';
      readonly receiptDigest: null;
      readonly ratified: false;
    }
  | { readonly state: 'qualified'; readonly receiptDigest: string; readonly ratified: true };

const qualified = (state: 'not_run' | 'incomplete' | 'unratified'): Qualification => ({
  state,
  receiptDigest: null,
  ratified: false,
});

/** A ratified qualification, distinguished by its receipt: acceptance takes only these. */
const ratified = (receipt: string): Qualification => ({
  state: 'qualified',
  receiptDigest: receipt.repeat(64),
  ratified: true,
});

type Execute = ReturnType<typeof createFabricDispatcher>;

describe('a compilation reproduces the one before it (KF-SAS-RQ-102)', () => {
  let harness: Harness;
  let fixtures: Fixtures;
  let workerPool: Pool;
  let store: InMemoryObjectStore;
  let repository: CompilerRuntimeRepository;
  let compositionId: string;
  let sources: Omit<Parameters<typeof createCompilationBasis>[0], 'compiler'>;
  let call: (
    actionType: string,
    targetIds: readonly string[],
    payload: Readonly<Record<string, unknown>>,
    author?: boolean,
    via?: Execute,
  ) => Promise<{ readonly actionId: string; readonly objectIds: readonly string[] }>;
  /** The same atoms without the acceptance precondition: what the database refuses on its own. */
  let executeUnchecked: Execute;

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
    const { accept_document_compilation: _unchecked, ...otherPreconditions } = atoms.preconditions;
    executeUnchecked = createFabricDispatcher(harness.pool, {
      ...atoms,
      preconditions: otherPreconditions,
    });
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
  }, 180_000);

  afterAll(async () => {
    await workerPool?.end();
    await harness?.stop();
  });

  /** Register the pin with this qualification, revoking the one enabled before it. */
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

  async function compile(
    basis: CompilationBasis,
    viewText: string,
    refusals: unknown[] = [],
  ): Promise<{ runId: string; status: string }> {
    const requested = await call('request_document_compilation', [compositionId], {
      basis_id: randomUUID(),
      basis,
    });
    const adapter = producing(viewText)(basis);
    const runtime = createCompilationRuntime({
      repository: {
        load: (actionId) => repository.load(actionId),
        persist: async (...args) => {
          try {
            return await repository.persist(...args);
          } catch (error: unknown) {
            refusals.push(error);
            throw error;
          }
        },
      },
      store,
      adapterFor: () => adapter,
    });
    return runtime.process(requested.actionId);
  }

  function accept(runId: string, via?: Execute): ReturnType<typeof call> {
    return withTransaction(harness.adminPool, (tx) =>
      tx.one<{ run_digest: string }>(
        'select run_digest from content.compilation_run where id = $1',
        [runId],
      ),
    ).then(({ run_digest }) =>
      call(
        'accept_document_compilation',
        [compositionId],
        { document_policy: 'ordinary', run_id: runId, run_digest },
        false,
        via,
      ),
    );
  }

  async function recorded(runId: string): Promise<Record<string, unknown>> {
    return withTransaction(harness.adminPool, (tx) =>
      tx.one(
        `select r.run_status, r.failure_code, r.failure_message, r.semantic_digest,
                (select count(*)::int from content.compiled_view v
                  where v.compilation_run_id = r.id) as views
           from content.compilation_run r where r.id = $1`,
        [runId],
      ),
    );
  }

  it('records a reproduction that differs as a failed run, and one that matches as a success', async () => {
    const a = await registerPin(qualified('not_run'));
    const first = await compile(a.basis, '# Compiled once\n');
    expect(first.status).toBe('succeeded');

    // The same binary, the same sources, a different qualification: a new Basis.
    const b = await registerPin(qualified('incomplete'), a.registrationId);
    expect(b.basis.basisDigest).not.toBe(a.basis.basisDigest);
    const refusals: unknown[] = [];
    const second = await compile(b.basis, '# Compiled differently\n', refusals);

    // The database refused the success; the worker recorded the refusal instead of losing it.
    expect(refusals).toHaveLength(1);
    expect(String((refusals[0] as Error).message)).toMatch(
      new RegExp(`KF-DOC-DETERMINISM-001: .*does not reproduce run ${first.runId}`),
    );
    expect(second.status).toBe('failed');
    expect(await recorded(second.runId)).toMatchObject({
      run_status: 'failed',
      failure_code: 'nondeterministic_output',
      semantic_digest: null,
      views: 0,
    });
    expect(String((await recorded(second.runId))['failure_message'])).toContain(first.runId);

    const c = await registerPin(qualified('unratified'), b.registrationId);
    const third = await compile(c.basis, '# Compiled once\n');
    expect(third.status).toBe('succeeded');
    expect(await recorded(third.runId)).toMatchObject({ run_status: 'succeeded', views: 1 });
  });

  it('does not accept a compilation of sources the same pinned compiler failed to reproduce', async () => {
    // Its own binary, so its own source identity, separate from the test above.
    const pin = { ...PIN, executableDigest: '7'.repeat(64) };
    const a = await registerPin(ratified('1'), undefined, pin);
    const first = await compile(a.basis, '# Accepted once\n');
    expect(first.status).toBe('succeeded');
    // No failed reproduction yet: the run is accepted.
    await expect(accept(first.runId)).resolves.toMatchObject({ actionId: expect.any(String) });

    const b = await registerPin(ratified('2'), a.registrationId, pin);
    const second = await compile(b.basis, '# Accepted differently\n');
    expect(second.status).toBe('failed');
    expect(await recorded(second.runId)).toMatchObject({
      failure_code: 'nondeterministic_output',
    });

    // The run the failure named is no longer accepted...
    await expect(accept(first.runId)).rejects.toThrow(/KF-DOC-DETERMINISM-002/);

    // ...nor a later requalification that happens to reproduce it: the binary, given these
    // sources, has produced something else.
    const c = await registerPin(ratified('3'), b.registrationId, pin);
    const third = await compile(c.basis, '# Accepted once\n');
    expect(third.status).toBe('succeeded');
    await expect(accept(third.runId)).rejects.toThrow(/KF-DOC-DETERMINISM-002/);

    // The database refuses it without the precondition.
    await expect(accept(third.runId, executeUnchecked)).rejects.toThrow(
      new RegExp(
        `KF-DOC-DETERMINISM-002: compilation run ${third.runId} cannot be accepted: ` +
          `run ${second.runId} `,
      ),
    );

    // A different binary over the same sources has no failed reproduction and is accepted, with
    // and without the precondition.
    const other = await registerPin(ratified('4'), undefined, {
      ...PIN,
      executableDigest: '8'.repeat(64),
    });
    const fourth = await compile(other.basis, '# Accepted by another binary\n');
    expect(fourth.status).toBe('succeeded');
    await expect(accept(fourth.runId)).resolves.toMatchObject({ actionId: expect.any(String) });
    await expect(accept(fourth.runId, executeUnchecked)).resolves.toMatchObject({
      actionId: expect.any(String),
    });
  });
});
