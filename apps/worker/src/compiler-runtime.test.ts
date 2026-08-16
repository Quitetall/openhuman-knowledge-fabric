import { canonicalize, digest } from '@kf/canonicalization';
import {
  createAuthoredFragmentRevision,
  createCompilationBasis,
  createCompositionRevision,
  type CompilerResponse,
  type DocumentCompilerAdapter,
  type LiminalCompilerIdentity,
} from '@kf/documents';
import { digestOf, InMemoryObjectStore } from '@kf/artifacts';
import type { Tx } from '@kf/database';
import { describe, expect, it, vi } from 'vitest';
import {
  compilationOutboxHandler,
  createCompilationRuntime,
  parseCompilerRuntimeRequest,
  type CompilerRuntimeRepository,
  type CompilerRuntimeRequest,
} from './compiler-runtime.js';

const ACTION_ID = '01940000-0000-8000-8000-000000000001';
const ACTOR_ID = '01940000-0000-8000-8000-000000000002';
const ROLE_ID = '01940000-0000-8000-8000-000000000003';
const ORGANIZATION_ID = '01940000-0000-8000-8000-000000000004';
const BASIS_ID = '01940000-0000-8000-8000-000000000005';
const FRAGMENT_BYTES = Buffer.from('# Constitution\n');
const VIEW_BYTES = Buffer.from('# Compiled constitution\n');

const identity: LiminalCompilerIdentity = {
  kind: 'liminal',
  name: 'liminal',
  version: '0.1.0',
  protocol: 'kf-document-v1',
  commitSha: '1'.repeat(40),
  cargoLockDigest: '2'.repeat(64),
  executableDigest: '3'.repeat(64),
  runtimeClosureDigest: '4'.repeat(64),
  qualification: { state: 'unratified', receiptDigest: null, ratified: false },
};

function basis(sourceBytes: Buffer = FRAGMENT_BYTES) {
  const fragment = createAuthoredFragmentRevision({
    id: '01940000-0000-8000-8000-000000000010',
    fragmentId: '01940000-0000-8000-8000-000000000011',
    previousRevisionId: null,
    mediaType: 'text/markdown',
    classification: 'internal',
    state: 'active',
    holder: {
      kind: 'fabric_native',
      subjectId: '01940000-0000-8000-8000-000000000011',
      artifactVersionId: '01940000-0000-8000-8000-000000000012',
      contentDigest: digestOf(sourceBytes),
    },
  });
  const composition = createCompositionRevision({
    id: '01940000-0000-8000-8000-000000000020',
    compositionId: '01940000-0000-8000-8000-000000000021',
    previousRevisionId: null,
    classification: 'internal',
    inputs: [{ ordinal: 1, role: 'fragment', fragmentRevisionId: fragment.id }],
  });
  return createCompilationBasis({
    protocol: 'kf-document-v1',
    rootCompositionRevisionId: composition.id,
    fragmentRevisions: [fragment],
    compositionRevisions: [composition],
    bindings: [],
    targetProfiles: [{ target: 'markdown', profileDigest: '4'.repeat(64) }],
    ontologyDigest: '5'.repeat(64),
    policyDigest: '6'.repeat(64),
    compiler: identity,
  });
}

function request(
  overrides: Partial<CompilerRuntimeRequest> = {},
  sourceBytes: Buffer = FRAGMENT_BYTES,
): CompilerRuntimeRequest {
  const compilationBasis = basis(sourceBytes);
  return {
    actionId: ACTION_ID,
    actorId: ACTOR_ID,
    actingRoleId: ROLE_ID,
    requestId: 'compiler-runtime-test',
    organizationId: ORGANIZATION_ID,
    maxClassification: 'internal',
    basisId: BASIS_ID,
    compilerRegistrationId: '01940000-0000-8000-8000-000000000006',
    draftOnly: true,
    basis: compilationBasis,
    inputs: [
      {
        kind: 'fragment',
        id: compilationBasis.fragmentRevisions[0]!.id,
        storageUri: 'artifacts/source/version',
        storageVersion: 'source-v1',
        contentDigest: digestOf(sourceBytes),
        sizeBytes: sourceBytes.length,
      },
    ],
    existing: null,
    ...overrides,
  };
}

function successfulAdapter(): DocumentCompilerAdapter {
  return {
    identity,
    compile: async (compilerRequest): Promise<CompilerResponse> => {
      const semanticGraph = { title: 'Constitution' };
      const fragment = compilerRequest.basis.fragmentRevisions[0]!;
      const provenance = {
        sourceKind: 'fragment' as const,
        sourceId: fragment.id,
        sourcePath: null,
        sourceDigest: fragment.holder.contentDigest,
      };
      return {
        protocol: 'kf-document-v1',
        basisDigest: compilerRequest.basisDigest,
        dependencyDigest: compilerRequest.dependencyDigest,
        semanticGraph,
        semanticDigest: digest(semanticGraph),
        hirProvenance: [{ nodeId: 'hir:constitution', ...provenance }],
        cirProvenance: [{ nodeId: 'cir:constitution', ...provenance }],
        unresolvedReferences: [],
        omittedSubgraphs: [],
        projectionCapabilities: [{ target: 'markdown', capabilities: ['source_map'] }],
        diagnostics: [],
        conversionLoss: [],
        views: [
          {
            target: 'markdown',
            mediaType: 'text/markdown',
            bytesBase64: VIEW_BYTES.toString('base64'),
            contentDigest: digestOf(VIEW_BYTES),
          },
        ],
      };
    },
  };
}

function repository(loaded: CompilerRuntimeRequest) {
  const persisted: Parameters<CompilerRuntimeRepository['persist']>[] = [];
  const value: CompilerRuntimeRepository = {
    load: async () => loaded,
    persist: async (...args) => {
      persisted.push(args);
      return args[1].id;
    },
  };
  return { value, persisted };
}

describe('document compiler runtime', () => {
  it('rebuilds the canonical Basis and rejects a stale database digest', () => {
    const valid = request();
    expect(parseCompilerRuntimeRequest(valid)).toEqual(valid);

    expect(() =>
      parseCompilerRuntimeRequest({
        ...valid,
        basis: { ...valid.basis, policyDigest: '7'.repeat(64) },
      }),
    ).toThrow(/basis does not exactly match/i);

    expect(() =>
      parseCompilerRuntimeRequest({
        ...valid,
        basis: {
          ...valid.basis,
          fragmentRevisions: [
            { ...valid.basis.fragmentRevisions[0]!, undocumented: 'must-not-be-ignored' },
          ],
        },
      }),
    ).toThrow(/basis does not exactly match/i);

    expect(() =>
      parseCompilerRuntimeRequest({
        ...valid,
        inputs: [{ ...valid.inputs[0]!, storageVersion: 'null' }],
      }),
    ).toThrow(/immutable object version/i);
  });

  it('loads exact versioned input, runs pinned adapter, verifies output storage, and persists once', async () => {
    const store = new InMemoryObjectStore();
    const inputStored = await store.put(
      'artifacts/source/version',
      FRAGMENT_BYTES,
      'text/markdown',
    );
    const loaded = request();
    const repo = repository({
      ...loaded,
      inputs: [{ ...loaded.inputs[0]!, storageVersion: inputStored.versionId! }],
    });
    const adapter = successfulAdapter();
    const compile = vi.spyOn(adapter, 'compile');
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: () => adapter,
      idFactory: (() => {
        let suffix = 100;
        return () => `01940000-0000-8000-8000-${String(suffix++).padStart(12, '0')}`;
      })(),
    });

    const result = await runtime.process(ACTION_ID);

    expect(result).toMatchObject({ status: 'succeeded', replayed: false });
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]![0].inputs).toEqual([
      {
        kind: 'fragment',
        id: basis().fragmentRevisions[0]!.id,
        bytesBase64: FRAGMENT_BYTES.toString('base64'),
        contentDigest: digestOf(FRAGMENT_BYTES),
      },
    ]);
    expect(repo.persisted).toHaveLength(1);
    expect(repo.persisted[0]![2]).toEqual([
      expect.objectContaining({
        target: 'markdown',
        contentDigest: digestOf(VIEW_BYTES),
        storageUri: `compiled-views/sha256/${digestOf(VIEW_BYTES)}`,
        storageVersion: expect.any(String),
      }),
    ]);
    const stored = repo.persisted[0]![2][0]!;
    await expect(store.read(stored.storageUri, stored.storageVersion)).resolves.toEqual(VIEW_BYTES);
  });

  it('fails compilation receipt when output storage returns the null-version sentinel', async () => {
    class SuspendedVersionStore extends InMemoryObjectStore {
      override async put(key: string, body: Buffer, mediaType: string) {
        const stored = await super.put(key, body, mediaType);
        return key.startsWith('compiled-views/') ? { ...stored, versionId: 'null' } : stored;
      }
    }

    const store = new SuspendedVersionStore();
    const inputStored = await store.put(
      'artifacts/source/version',
      FRAGMENT_BYTES,
      'text/markdown',
    );
    const loaded = request();
    const repo = repository({
      ...loaded,
      inputs: [{ ...loaded.inputs[0]!, storageVersion: inputStored.versionId! }],
    });
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: successfulAdapter,
    });

    await expect(runtime.process(ACTION_ID)).resolves.toMatchObject({ status: 'failed' });
    expect(repo.persisted[0]![1]).toMatchObject({
      status: 'failed',
      failureMessage: expect.stringMatching(/versioning is required/),
    });
    expect(repo.persisted[0]![2]).toEqual([]);
  });

  it('records a failed run without invoking compiler when exact input bytes are corrupted', async () => {
    const store = new InMemoryObjectStore();
    const inputStored = await store.put(
      'artifacts/source/version',
      Buffer.from('tampered'),
      'text/markdown',
    );
    const repo = repository(
      request({
        inputs: [
          {
            ...request().inputs[0]!,
            storageVersion: inputStored.versionId!,
          },
        ],
      }),
    );
    const adapter = successfulAdapter();
    const compile = vi.spyOn(adapter, 'compile');
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: () => adapter,
    });

    const result = await runtime.process(ACTION_ID);

    expect(result).toMatchObject({ status: 'failed', replayed: false });
    expect(compile).not.toHaveBeenCalled();
    expect(repo.persisted[0]![1]).toMatchObject({
      status: 'failed',
      failureCode: 'input_digest_mismatch',
    });
    expect(repo.persisted[0]![2]).toEqual([]);
  });

  it('rejects declared aggregate input size before object reads or base64 materialization', async () => {
    const store = new InMemoryObjectStore();
    const read = vi.spyOn(store, 'read');
    const repo = repository(
      request({
        inputs: [{ ...request().inputs[0]!, sizeBytes: 11 }],
      }),
    );
    const adapter = successfulAdapter();
    const compile = vi.spyOn(adapter, 'compile');
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: () => adapter,
      maxSourceBytes: 10,
    });

    await expect(runtime.process(ACTION_ID)).resolves.toMatchObject({ status: 'failed' });
    expect(read).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
    expect(repo.persisted[0]![1]).toMatchObject({
      failureCode: 'input_size_limit_exceeded',
    });
  });

  it('reserves canonical-envelope headroom by capping default decoded sources at 10 MiB', async () => {
    const store = new InMemoryObjectStore();
    const read = vi.spyOn(store, 'read');
    const repo = repository(
      request({
        inputs: [
          {
            ...request().inputs[0]!,
            sizeBytes: 10 * 1024 * 1024 + 1,
          },
        ],
      }),
    );
    const adapter = successfulAdapter();
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: () => adapter,
    });

    await expect(runtime.process(ACTION_ID)).resolves.toMatchObject({ status: 'failed' });
    expect(read).not.toHaveBeenCalled();
    expect(repo.persisted[0]![1]).toMatchObject({
      failureCode: 'input_size_limit_exceeded',
    });
  });

  it('accepts an exact 10 MiB source while leaving room in the 16 MiB canonical envelope', async () => {
    const sourceBytes = Buffer.alloc(10 * 1024 * 1024, 0x61);
    const loaded = request({}, sourceBytes);
    const store = new InMemoryObjectStore();
    const stored = await store.put(loaded.inputs[0]!.storageUri, sourceBytes, 'text/markdown');
    const repo = repository({
      ...loaded,
      inputs: [{ ...loaded.inputs[0]!, storageVersion: stored.versionId! }],
    });
    const adapter = successfulAdapter();
    const compile = vi.spyOn(adapter, 'compile');
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: () => adapter,
    });

    const result = await runtime.process(ACTION_ID);
    expect(repo.persisted[0]![1]).toMatchObject({
      status: 'succeeded',
      failureCode: null,
      failureMessage: null,
    });
    expect(result).toMatchObject({ status: 'succeeded' });
    const compilerRequest = compile.mock.calls[0]![0];
    const encodedBytes = Buffer.byteLength(compilerRequest.inputs[0]!.bytesBase64);
    expect(encodedBytes).toBe(13_981_016);
    expect(Buffer.byteLength(`${canonicalize(compilerRequest)}\n`)).toBeLessThan(16 * 1024 * 1024);
  });

  it('records an oversized canonical envelope before invoking the adapter', async () => {
    const loaded = request();
    const oversizedBasis = createCompilationBasis({
      protocol: loaded.basis.protocol,
      rootCompositionRevisionId: loaded.basis.rootCompositionRevisionId,
      fragmentRevisions: loaded.basis.fragmentRevisions,
      compositionRevisions: loaded.basis.compositionRevisions,
      bindings: loaded.basis.bindings,
      targetProfiles: [
        {
          target: 'x'.repeat(16 * 1024 * 1024),
          profileDigest: '4'.repeat(64),
        },
      ],
      ontologyDigest: loaded.basis.ontologyDigest,
      policyDigest: loaded.basis.policyDigest,
      compiler: loaded.basis.compiler,
    });
    const store = new InMemoryObjectStore();
    const stored = await store.put(loaded.inputs[0]!.storageUri, FRAGMENT_BYTES, 'text/markdown');
    const repo = repository({
      ...loaded,
      basis: oversizedBasis,
      inputs: [{ ...loaded.inputs[0]!, storageVersion: stored.versionId! }],
    });
    const adapter = successfulAdapter();
    const compile = vi.spyOn(adapter, 'compile');
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: () => adapter,
    });

    await expect(runtime.process(ACTION_ID)).resolves.toMatchObject({ status: 'failed' });
    expect(compile).not.toHaveBeenCalled();
    expect(repo.persisted[0]![1]).toMatchObject({
      failureCode: 'input_size_limit_exceeded',
      failureMessage: 'canonical compiler input exceeded 16777216 bytes',
    });
  });

  it('passes the exact per-input remaining cap and records a bounded-read refusal', async () => {
    const store = new InMemoryObjectStore();
    const stored = await store.put('artifacts/source/version', FRAGMENT_BYTES, 'text/markdown');
    const read = vi.spyOn(store, 'read');
    const loaded = request();
    const repo = repository({
      ...loaded,
      inputs: [{ ...loaded.inputs[0]!, storageVersion: stored.versionId!, sizeBytes: 1 }],
    });
    const adapter = successfulAdapter();
    const compile = vi.spyOn(adapter, 'compile');
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: () => adapter,
      maxSourceBytes: 10,
    });

    await expect(runtime.process(ACTION_ID)).resolves.toMatchObject({ status: 'failed' });
    expect(read).toHaveBeenCalledWith('artifacts/source/version', stored.versionId, 1);
    expect(compile).not.toHaveBeenCalled();
    expect(repo.persisted[0]![1]).toMatchObject({
      failureCode: 'input_size_limit_exceeded',
      failureMessage: `fragment:${basis().fragmentRevisions[0]!.id} exceeded declared or remaining read cap 1`,
    });
  });

  it('tightens each object read to its declared size within the remaining aggregate budget', async () => {
    const firstBytes = Buffer.from('four');
    const secondBytes = Buffer.from('sixsix');
    const firstFragment = createAuthoredFragmentRevision({
      id: '01940000-0000-8000-8000-000000000041',
      fragmentId: '01940000-0000-8000-8000-000000000042',
      previousRevisionId: null,
      mediaType: 'text/markdown',
      classification: 'internal',
      state: 'active',
      holder: {
        kind: 'fabric_native',
        subjectId: '01940000-0000-8000-8000-000000000042',
        artifactVersionId: '01940000-0000-8000-8000-000000000043',
        contentDigest: digestOf(firstBytes),
      },
    });
    const secondFragment = createAuthoredFragmentRevision({
      id: '01940000-0000-8000-8000-000000000044',
      fragmentId: '01940000-0000-8000-8000-000000000045',
      previousRevisionId: null,
      mediaType: 'text/markdown',
      classification: 'internal',
      state: 'active',
      holder: {
        kind: 'fabric_native',
        subjectId: '01940000-0000-8000-8000-000000000045',
        artifactVersionId: '01940000-0000-8000-8000-000000000046',
        contentDigest: digestOf(secondBytes),
      },
    });
    const composition = createCompositionRevision({
      id: '01940000-0000-8000-8000-000000000047',
      compositionId: '01940000-0000-8000-8000-000000000048',
      previousRevisionId: null,
      classification: 'internal',
      inputs: [
        { ordinal: 1, role: 'fragment', fragmentRevisionId: firstFragment.id },
        { ordinal: 2, role: 'fragment', fragmentRevisionId: secondFragment.id },
      ],
    });
    const multiBasis = createCompilationBasis({
      protocol: 'kf-document-v1',
      rootCompositionRevisionId: composition.id,
      fragmentRevisions: [firstFragment, secondFragment],
      compositionRevisions: [composition],
      bindings: [],
      targetProfiles: [{ target: 'markdown', profileDigest: '4'.repeat(64) }],
      ontologyDigest: '5'.repeat(64),
      policyDigest: '6'.repeat(64),
      compiler: identity,
    });
    const store = new InMemoryObjectStore();
    const firstStored = await store.put('source/first', firstBytes, 'text/markdown');
    const secondStored = await store.put('source/second', secondBytes, 'text/markdown');
    const read = vi.spyOn(store, 'read');
    const repo = repository(
      request({
        basis: multiBasis,
        inputs: [
          {
            kind: 'fragment',
            id: firstFragment.id,
            storageUri: firstStored.key,
            storageVersion: firstStored.versionId!,
            contentDigest: digestOf(firstBytes),
            sizeBytes: firstBytes.length,
          },
          {
            kind: 'fragment',
            id: secondFragment.id,
            storageUri: secondStored.key,
            storageVersion: secondStored.versionId!,
            contentDigest: digestOf(secondBytes),
            sizeBytes: 5,
          },
        ],
      }),
    );
    const adapter = successfulAdapter();
    const compile = vi.spyOn(adapter, 'compile');
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: () => adapter,
      maxSourceBytes: 9,
    });

    await expect(runtime.process(ACTION_ID)).resolves.toMatchObject({ status: 'failed' });
    expect(read.mock.calls).toEqual([
      ['source/first', firstStored.versionId, 4],
      ['source/second', secondStored.versionId, 5],
    ]);
    expect(compile).not.toHaveBeenCalled();
    expect(repo.persisted[0]![1]).toMatchObject({
      failureCode: 'input_size_limit_exceeded',
      failureMessage: `fragment:${secondFragment.id} exceeded declared or remaining read cap 5`,
    });
  });

  it('replays terminal receipt only after re-verifying every recorded output version', async () => {
    const store = new InMemoryObjectStore();
    const output = await store.put(
      `compiled-views/sha256/${digestOf(VIEW_BYTES)}`,
      VIEW_BYTES,
      'text/markdown',
    );
    const repo = repository(
      request({
        existing: {
          runId: '01940000-0000-8000-8000-000000000099',
          runDigest: '7'.repeat(64),
          status: 'succeeded',
          views: [
            {
              target: 'markdown',
              mediaType: 'text/markdown',
              contentDigest: digestOf(VIEW_BYTES),
              sizeBytes: VIEW_BYTES.length,
              storageUri: output.key,
              storageVersion: output.versionId!,
            },
          ],
        },
      }),
    );
    const adapter = successfulAdapter();
    const runtime = createCompilationRuntime({
      repository: repo.value,
      store,
      adapterFor: () => adapter,
    });

    await expect(runtime.process(ACTION_ID)).resolves.toEqual({
      runId: '01940000-0000-8000-8000-000000000099',
      status: 'succeeded',
      replayed: true,
    });
    expect(repo.persisted).toEqual([]);

    store.tamper(output.key, Buffer.alloc(VIEW_BYTES.length, 0x78));
    await expect(runtime.process(ACTION_ID)).rejects.toThrow(/recorded compiled view digest/);
  });

  it('bridges only a typed request outbox event to one keyed compiler job', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const tx = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return [];
      },
      // Every method the real `Tx` declares is present, and the ones this handler must not
      // reach throw rather than returning a plausible empty result. A fake that simply omits
      // a method makes the handler's actual dependency surface unobservable: it would have
      // to grow a call to a method the fake lacks before anything noticed, and by then the
      // fake is silently a different contract from the one production code is given.
      queryWithTextParsers: async () => {
        throw new Error('not used');
      },
      one: async () => {
        throw new Error('not used');
      },
      maybeOne: async () => {
        throw new Error('not used');
      },
    } satisfies Tx;

    await compilationOutboxHandler(tx, { action_id: ACTION_ID, targets: [BASIS_ID] });

    expect(calls[0]).toMatchObject({
      sql: expect.stringContaining('search.index_object'),
      params: [BASIS_ID],
    });
    expect(calls[1]).toMatchObject({
      sql: expect.stringContaining('graphile_worker.add_job'),
      params: [ACTION_ID],
    });
    await expect(compilationOutboxHandler(tx, { targets: [BASIS_ID] })).rejects.toThrow(
      /action_id/,
    );
  });
});
