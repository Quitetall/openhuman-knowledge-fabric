import { describe, expect, it } from 'vitest';
import { canonicalize, digest, digestBytes } from '@kf/canonicalization';
import {
  assertCompilationMayBeAccepted,
  canonicalCompilationRunPreimage,
  createAuthoredFragmentRevision,
  createCompilationBasis,
  createCompositionRevision,
  createProposalOverlay,
  createTypedBinding,
  DocumentCompilerError,
  runCompilation,
  verifyCompilationRunPreimage,
  type CompilationBasis,
  type CompilerIdentity,
  type CompilerResponse,
  type CompilationRequest,
} from './compiler.js';

const ZERO_DIGEST = '0'.repeat(64);
const ONE_DIGEST = '1'.repeat(64);
const TITLE_DIGEST = 'e01b17ff9af77056792f67c57e3d1908795b9d1ae4cfe72421d0a2838991b740';
const SECOND_SOURCE_BYTES = Buffer.from('second source');
const SECOND_SOURCE_DIGEST = digestBytes(SECOND_SOURCE_BYTES);

function testModelProvenance() {
  const includedItems = [
    {
      subject_id: 'fragment-1',
      revision_id: 'fragment-revision-1',
      classification: 'internal' as const,
      kind: 'document' as const,
      token_count: 8,
      content_digest: TITLE_DIGEST,
      provenance_digest: ONE_DIGEST,
    },
  ];
  const contextClaim = {
    tokenizer: 'fixture-tokenizer-v1',
    token_budget: 32,
    instruction_digest: '2'.repeat(64),
    included_items: includedItems,
    omitted_subject_ids: [] as string[],
  };
  return {
    request_id: 'request-1',
    basis_id: 'basis-1',
    classification: 'internal' as const,
    provider: {
      provider_id: 'local',
      model_id: 'editor-v1',
      locality: 'local' as const,
    },
    policy: {
      policy_id: 'local-document-policy-v1',
      decision: { locality: 'local' as const, classification_ceiling: 'internal' as const },
    },
    context: {
      ...contextClaim,
      context_digest: digest(contextClaim),
    },
  };
}

function testCompiler(): CompilerIdentity {
  return {
    kind: 'in_memory',
    name: 'deterministic-test-compiler',
    version: '1.0.0',
    protocol: 'kf-document-v1',
    executableDigest: '3'.repeat(64),
  };
}

function qualifiedCompiler(): CompilerIdentity {
  return {
    kind: 'liminal',
    name: 'liminal-compiler',
    version: '1.0.0',
    protocol: 'kf-document-v1',
    commitSha: 'a'.repeat(40),
    cargoLockDigest: '4'.repeat(64),
    executableDigest: '5'.repeat(64),
    runtimeClosureDigest: '7'.repeat(64),
    qualification: { state: 'qualified', receiptDigest: '6'.repeat(64), ratified: true },
  };
}

function testBasis(compiler: CompilerIdentity = testCompiler()): CompilationBasis {
  const fragment = createAuthoredFragmentRevision({
    id: 'fragment-revision-1',
    fragmentId: 'fragment-1',
    previousRevisionId: null,
    mediaType: 'text/markdown',
    classification: 'internal',
    state: 'active',
    holder: {
      kind: 'fabric_native',
      subjectId: 'fragment-1',
      artifactVersionId: 'artifact-version-1',
      contentDigest: TITLE_DIGEST,
    },
  });
  const composition = createCompositionRevision({
    id: 'composition-revision-1',
    compositionId: 'composition-1',
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
    targetProfiles: [{ target: 'markdown', profileDigest: ZERO_DIGEST }],
    ontologyDigest: ONE_DIGEST,
    policyDigest: '2'.repeat(64),
    compiler,
  });
}

function testCompilerResponse(request: CompilationRequest): CompilerResponse {
  return {
    protocol: request.protocol,
    basisDigest: request.basisDigest,
    dependencyDigest: request.dependencyDigest,
    semanticGraph: { nodes: [] },
    semanticDigest: 'acf2fa576acb702442f9d0101673354c398db67315c066ca48be8db8e0d2c75b',
    hirProvenance: [
      {
        nodeId: 'hir:title',
        sourceKind: 'fragment',
        sourceId: 'fragment-revision-1',
        sourcePath: '/heading/0',
        sourceDigest: TITLE_DIGEST,
      },
    ],
    cirProvenance: [
      {
        nodeId: 'cir:title',
        sourceKind: 'fragment',
        sourceId: 'fragment-revision-1',
        sourcePath: '/heading/0',
        sourceDigest: TITLE_DIGEST,
      },
    ],
    unresolvedReferences: [
      {
        sourceNodeId: 'cir:title',
        reference: 'KF-MISSING',
        reasonCode: 'not_in_basis',
        message: 'Reference is intentionally unresolved in the frozen Basis',
      },
    ],
    omittedSubgraphs: [
      {
        rootNodeId: 'cir:restricted-appendix',
        reasonCode: 'projection_policy',
        message: 'Projection policy omits the appendix',
      },
    ],
    projectionCapabilities: [
      { target: 'markdown', capabilities: ['human_readable', 'source_map'] },
    ],
    diagnostics: [{ severity: 'warning', code: 'fixture_warning', message: 'Fixture warning' }],
    conversionLoss: [
      { code: 'fixture_loss', path: '/heading/0', message: 'Fixture conversion loss' },
    ],
    views: [
      {
        target: 'markdown',
        mediaType: 'text/markdown',
        bytesBase64: 'IyBUaXRsZQo=',
        contentDigest: TITLE_DIGEST,
      },
    ],
  };
}

describe('authored fragment revisions', () => {
  it('pins one source holder and produces an immutable canonical revision', () => {
    const first = createAuthoredFragmentRevision({
      id: 'fragment-revision-1',
      fragmentId: 'fragment-1',
      previousRevisionId: null,
      mediaType: 'text/markdown',
      classification: 'internal',
      state: 'active',
      holder: {
        kind: 'git',
        subjectId: 'fragment-1',
        repository: 'https://example.invalid/docs.git',
        commitSha: 'a'.repeat(40),
        path: 'docs/atom.md',
        submoduleCommitSha: null,
        contentDigest: ZERO_DIGEST,
      },
    });
    const reordered = createAuthoredFragmentRevision({
      state: 'active',
      holder: {
        path: 'docs/atom.md',
        commitSha: 'a'.repeat(40),
        contentDigest: ZERO_DIGEST,
        repository: 'https://example.invalid/docs.git',
        submoduleCommitSha: null,
        subjectId: 'fragment-1',
        kind: 'git',
      },
      classification: 'internal',
      mediaType: 'text/markdown',
      previousRevisionId: null,
      fragmentId: 'fragment-1',
      id: 'fragment-revision-1',
    });

    expect(first.revisionDigest).toBe(reordered.revisionDigest);
    expect(first.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.holder)).toBe(true);
  });

  it('rejects a mixed holder instead of creating dual-write authority', () => {
    expect(() =>
      createAuthoredFragmentRevision({
        id: 'fragment-revision-1',
        fragmentId: 'fragment-1',
        previousRevisionId: null,
        mediaType: 'text/markdown',
        classification: 'internal',
        state: 'active',
        holder: {
          kind: 'fabric_native',
          subjectId: 'fragment-1',
          artifactVersionId: 'artifact-version-1',
          contentDigest: ONE_DIGEST,
          repository: 'https://example.invalid/also-written-here.git',
        } as never,
      }),
    ).toThrow(DocumentCompilerError);
  });
});

describe('composition revisions', () => {
  it('uses explicit contiguous ordinals as the stable declared order', () => {
    const revision = createCompositionRevision({
      id: 'composition-revision-1',
      compositionId: 'composition-1',
      previousRevisionId: null,
      classification: 'internal',
      inputs: [
        {
          ordinal: 2,
          role: 'resource',
          resourceVersionId: 'style-v1',
          contentDigest: ONE_DIGEST,
          classification: 'internal',
        },
        { ordinal: 1, role: 'fragment', fragmentRevisionId: 'fragment-revision-1' },
      ],
    });

    expect(revision.inputs.map((input) => input.ordinal)).toEqual([1, 2]);
    expect(revision.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(revision.inputs)).toBe(true);
    expect(() =>
      createCompositionRevision({
        id: 'composition-revision-2',
        compositionId: 'composition-1',
        previousRevisionId: 'composition-revision-1',
        classification: 'internal',
        inputs: [
          { ordinal: 1, role: 'fragment', fragmentRevisionId: 'fragment-revision-1' },
          { ordinal: 3, role: 'fragment', fragmentRevisionId: 'fragment-revision-2' },
        ],
      }),
    ).toThrow(/contiguous/);
  });
});

describe('typed bindings', () => {
  it('pins an exact object revision and validates its resolved value type', () => {
    const binding = createTypedBinding({
      id: 'binding-release-status',
      source: { kind: 'object_revision', objectId: 'release-1', objectRevision: 7 },
      sourceClassification: 'confidential',
      selector: 'lifecycle_state',
      expectedType: 'string',
      renderer: 'plain_text',
      value: 'released',
    });

    expect(binding.valueDigest).toBe(
      '4281d8b57cf3adf2ada161a725812ee94f2f91e1b7699000f76cfa7bd7bcc35a',
    );
    expect(binding.bindingDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      createTypedBinding({
        id: 'binding-release-status',
        source: { kind: 'snapshot', objectId: 'release-1', snapshotId: 'snapshot-7' },
        sourceClassification: 'confidential',
        selector: 'lifecycle_state',
        expectedType: 'boolean',
        renderer: 'plain_text',
        value: 'released',
      }),
    ).toThrow(/expected boolean/);
  });
});

describe('compilation bases', () => {
  it('rejects a cycle in the exact composition-revision graph', () => {
    const first = createCompositionRevision({
      id: 'composition-a-r1',
      compositionId: 'composition-a',
      previousRevisionId: null,
      classification: 'internal',
      inputs: [{ ordinal: 1, role: 'composition', compositionRevisionId: 'composition-b-r1' }],
    });
    const second = createCompositionRevision({
      id: 'composition-b-r1',
      compositionId: 'composition-b',
      previousRevisionId: null,
      classification: 'internal',
      inputs: [{ ordinal: 1, role: 'composition', compositionRevisionId: 'composition-a-r1' }],
    });

    let thrown: unknown;
    try {
      createCompilationBasis({
        protocol: 'kf-document-v1',
        rootCompositionRevisionId: first.id,
        fragmentRevisions: [],
        compositionRevisions: [first, second],
        bindings: [],
        targetProfiles: [{ target: 'markdown', profileDigest: ZERO_DIGEST }],
        ontologyDigest: ONE_DIGEST,
        policyDigest: '2'.repeat(64),
        compiler: {
          kind: 'in_memory',
          name: 'deterministic-test-compiler',
          version: '1.0.0',
          protocol: 'kf-document-v1',
          executableDigest: '3'.repeat(64),
        },
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'composition_cycle' });
  });

  it('derives and freezes the maximum classification across every transitive input kind', () => {
    const fragment = createAuthoredFragmentRevision({
      id: 'fragment-r1',
      fragmentId: 'fragment',
      previousRevisionId: null,
      mediaType: 'text/markdown',
      classification: 'internal',
      state: 'active',
      holder: {
        kind: 'external',
        subjectId: 'fragment',
        authority: 'fixture',
        revision: '1',
        contentDigest: ZERO_DIGEST,
      },
    });
    const binding = createTypedBinding({
      id: 'binding-r1',
      source: { kind: 'snapshot', objectId: 'record-1', snapshotId: 'snapshot-1' },
      sourceClassification: 'confidential',
      selector: 'status',
      expectedType: 'string',
      renderer: 'plain_text',
      value: 'released',
    });
    const child = createCompositionRevision({
      id: 'child-r1',
      compositionId: 'child',
      previousRevisionId: null,
      classification: 'confidential',
      inputs: [{ ordinal: 1, role: 'fragment', fragmentRevisionId: fragment.id }],
    });
    const root = createCompositionRevision({
      id: 'root-r1',
      compositionId: 'root',
      previousRevisionId: null,
      classification: 'public',
      inputs: [
        { ordinal: 1, role: 'composition', compositionRevisionId: child.id },
        {
          ordinal: 2,
          role: 'resource',
          resourceVersionId: 'resource-r1',
          contentDigest: ONE_DIGEST,
          classification: 'restricted',
        },
        { ordinal: 3, role: 'binding', bindingId: binding.id },
        {
          ordinal: 4,
          role: 'generated_view',
          compiledViewId: 'view-r1',
          contentDigest: '2'.repeat(64),
          classification: 'internal',
        },
      ],
    });

    const basis = createCompilationBasis({
      protocol: 'kf-document-v1',
      rootCompositionRevisionId: root.id,
      fragmentRevisions: [fragment],
      compositionRevisions: [root, child],
      bindings: [binding],
      targetProfiles: [{ target: 'markdown', profileDigest: ZERO_DIGEST }],
      ontologyDigest: ONE_DIGEST,
      policyDigest: '2'.repeat(64),
      compiler: testCompiler(),
      // Runtime derivation must ignore a structurally forged caller downgrade.
      effectiveClassification: 'public',
    } as never);

    expect(basis.effectiveClassification).toBe('restricted');
    expect(Object.isFrozen(basis)).toBe(true);
  });

  it.each(['fragment', 'composition', 'resource', 'binding', 'generated_view'] as const)(
    'includes %s authority in the maximum classification',
    (elevatedKind) => {
      const classificationFor = (kind: typeof elevatedKind) =>
        kind === elevatedKind ? ('confidential' as const) : ('public' as const);
      const fragment = createAuthoredFragmentRevision({
        id: 'fragment-r1',
        fragmentId: 'fragment',
        previousRevisionId: null,
        mediaType: 'text/markdown',
        classification: classificationFor('fragment'),
        state: 'active',
        holder: {
          kind: 'external',
          subjectId: 'fragment',
          authority: 'fixture',
          revision: '1',
          contentDigest: ZERO_DIGEST,
        },
      });
      const binding = createTypedBinding({
        id: 'binding-r1',
        source: { kind: 'object_revision', objectId: 'record-1', objectRevision: 1 },
        sourceClassification: classificationFor('binding'),
        selector: 'status',
        expectedType: 'string',
        renderer: 'plain_text',
        value: 'released',
      });
      const child = createCompositionRevision({
        id: 'child-r1',
        compositionId: 'child',
        previousRevisionId: null,
        classification: classificationFor('composition'),
        inputs: [{ ordinal: 1, role: 'fragment', fragmentRevisionId: fragment.id }],
      });
      const root = createCompositionRevision({
        id: 'root-r1',
        compositionId: 'root',
        previousRevisionId: null,
        classification: 'public',
        inputs: [
          { ordinal: 1, role: 'composition', compositionRevisionId: child.id },
          {
            ordinal: 2,
            role: 'resource',
            resourceVersionId: 'resource-r1',
            contentDigest: ONE_DIGEST,
            classification: classificationFor('resource'),
          },
          { ordinal: 3, role: 'binding', bindingId: binding.id },
          {
            ordinal: 4,
            role: 'generated_view',
            compiledViewId: 'view-r1',
            contentDigest: '2'.repeat(64),
            classification: classificationFor('generated_view'),
          },
        ],
      });

      const basis = createCompilationBasis({
        protocol: 'kf-document-v1',
        rootCompositionRevisionId: root.id,
        fragmentRevisions: [fragment],
        compositionRevisions: [root, child],
        bindings: [binding],
        targetProfiles: [{ target: 'markdown', profileDigest: ZERO_DIGEST }],
        ontologyDigest: ONE_DIGEST,
        policyDigest: '2'.repeat(64),
        compiler: testCompiler(),
      });

      expect(basis.effectiveClassification).toBe('confidential');
    },
  );
});

describe('compiler runs', () => {
  it('refuses an object that did not pass through compiler verification', () => {
    const forged = {
      id: 'forged',
      basisDigest: ZERO_DIGEST,
      compilerDigest: ONE_DIGEST,
      dependencyDigest: '2'.repeat(64),
      status: 'succeeded',
      draftOnly: false,
      effectiveClassification: 'public',
      semanticDigest: '3'.repeat(64),
      failureCode: null,
      failureMessage: null,
      diagnostics: [],
      conversionLoss: [],
      views: [],
      runDigest: '4'.repeat(64),
    } as never;

    expect(() => assertCompilationMayBeAccepted(forged)).toThrow(/verified compiler run/);
  });

  it('verifies basis-bound input and output digests before exposing a compiled view', async () => {
    const basis = testBasis(qualifiedCompiler());
    const run = await runCompilation({
      id: 'run-1',
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile(request) {
          return {
            protocol: 'kf-document-v1',
            basisDigest: request.basisDigest,
            dependencyDigest: request.dependencyDigest,
            semanticGraph: { nodes: [] },
            semanticDigest: 'acf2fa576acb702442f9d0101673354c398db67315c066ca48be8db8e0d2c75b',
            hirProvenance: [
              {
                nodeId: 'hir:title',
                sourceKind: 'fragment',
                sourceId: 'fragment-revision-1',
                sourcePath: '/heading/0',
                sourceDigest: TITLE_DIGEST,
              },
            ],
            cirProvenance: [
              {
                nodeId: 'cir:title',
                sourceKind: 'fragment',
                sourceId: 'fragment-revision-1',
                sourcePath: '/heading/0',
                sourceDigest: TITLE_DIGEST,
              },
            ],
            unresolvedReferences: [
              {
                sourceNodeId: 'cir:title',
                reference: 'KF-MISSING',
                reasonCode: 'not_in_basis',
                message: 'Reference is intentionally unresolved in the frozen Basis',
              },
            ],
            omittedSubgraphs: [
              {
                rootNodeId: 'cir:restricted-appendix',
                reasonCode: 'projection_policy',
                message: 'Projection policy omits the appendix',
              },
            ],
            projectionCapabilities: [
              { target: 'markdown', capabilities: ['human_readable', 'source_map'] },
            ],
            diagnostics: [],
            conversionLoss: [],
            views: [
              {
                target: 'markdown',
                mediaType: 'text/markdown',
                bytesBase64: 'IyBUaXRsZQo=',
                contentDigest: TITLE_DIGEST,
              },
            ],
          };
        },
      },
    });

    expect(run.status).toBe('succeeded');
    expect(run.effectiveClassification).toBe('internal');
    expect(run.views).toEqual([
      {
        target: 'markdown',
        mediaType: 'text/markdown',
        bytesBase64: 'IyBUaXRsZQo=',
        contentDigest: TITLE_DIGEST,
        effectiveClassification: 'internal',
      },
    ]);
    expect(run.semanticDigest).toBe(
      'acf2fa576acb702442f9d0101673354c398db67315c066ca48be8db8e0d2c75b',
    );
    expect(run.hirProvenance).toHaveLength(1);
    expect(run.cirProvenance).toHaveLength(1);
    expect(run.unresolvedReferences).toMatchObject([{ reference: 'KF-MISSING' }]);
    expect(run.omittedSubgraphs).toMatchObject([{ rootNodeId: 'cir:restricted-appendix' }]);
    expect(run.projectionCapabilities).toEqual([
      { target: 'markdown', capabilities: ['human_readable', 'source_map'] },
    ]);
    expect(run.runDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(run)).toBe(true);
    expect(() => assertCompilationMayBeAccepted(run)).toThrow(/unresolved references/);

    const canonicalPreimage = canonicalCompilationRunPreimage(run);
    expect(verifyCompilationRunPreimage(canonicalPreimage, run.runDigest)).toMatchObject({
      id: run.id,
      semanticGraph: { nodes: [] },
      semanticDigest: run.semanticDigest,
    });

    const forgedSemanticPreimage = canonicalize({
      ...JSON.parse(canonicalPreimage),
      semanticGraph: { nodes: [{ id: 'forged' }] },
    });
    expect(() =>
      verifyCompilationRunPreimage(
        forgedSemanticPreimage,
        digestBytes(Buffer.from(forgedSemanticPreimage, 'utf8')),
      ),
    ).toThrow(/semantic graph/i);
  });

  it('refuses acceptance when a successful compiler run omitted a subgraph', async () => {
    const basis = testBasis(qualifiedCompiler());
    const run = await runCompilation({
      id: 'run-omitted-subgraph',
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile(request) {
          return {
            ...testCompilerResponse(request),
            unresolvedReferences: [],
            conversionLoss: [],
          };
        },
      },
    });

    expect(run.status).toBe('succeeded');
    expect(() => assertCompilationMayBeAccepted(run)).toThrow(/omitted subgraphs/);
  });

  it('fails compilation without complete Basis-bound HIR and CIR provenance', async () => {
    const basis = testBasis(qualifiedCompiler());
    const run = await runCompilation({
      id: 'run-empty-provenance',
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile(request) {
          return {
            ...testCompilerResponse(request),
            hirProvenance: [],
            cirProvenance: [],
            unresolvedReferences: [],
            omittedSubgraphs: [],
            conversionLoss: [],
          };
        },
      },
    });

    expect(run).toMatchObject({ status: 'failed', failureCode: 'missing_provenance_coverage' });
    expect(run.views).toEqual([]);
  });

  it.each([
    [
      'source outside the Basis',
      { sourceId: 'fragment-revision-outside-basis', sourceDigest: TITLE_DIGEST },
      'provenance_source_not_in_basis',
    ],
    [
      'digest outside the Basis',
      { sourceId: 'fragment-revision-1', sourceDigest: ZERO_DIGEST },
      'provenance_digest_mismatch',
    ],
  ] as const)('rejects HIR provenance with a %s', async (_label, override, failureCode) => {
    const basis = testBasis();
    const run = await runCompilation({
      id: `run-${failureCode}`,
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile(request) {
          const response = testCompilerResponse(request);
          return {
            ...response,
            hirProvenance: [{ ...response.hirProvenance[0]!, ...override }],
          };
        },
      },
    });

    expect(run).toMatchObject({ status: 'failed', failureCode });
    expect(run.views).toEqual([]);
  });

  it('rejects a compiler that silently omits one Basis source from HIR or CIR provenance', async () => {
    const first = testBasis();
    const secondFragment = createAuthoredFragmentRevision({
      id: 'fragment-revision-2',
      fragmentId: 'fragment-2',
      previousRevisionId: null,
      mediaType: 'text/markdown',
      classification: 'internal',
      state: 'active',
      holder: {
        kind: 'fabric_native',
        subjectId: 'fragment-2',
        artifactVersionId: 'artifact-version-2',
        contentDigest: SECOND_SOURCE_DIGEST,
      },
    });
    const composition = createCompositionRevision({
      id: 'composition-revision-two-inputs',
      compositionId: 'composition-two-inputs',
      previousRevisionId: null,
      classification: 'internal',
      inputs: [
        { ordinal: 1, role: 'fragment', fragmentRevisionId: 'fragment-revision-1' },
        { ordinal: 2, role: 'fragment', fragmentRevisionId: secondFragment.id },
      ],
    });
    const basis = createCompilationBasis({
      protocol: first.protocol,
      rootCompositionRevisionId: composition.id,
      fragmentRevisions: [...first.fragmentRevisions, secondFragment],
      compositionRevisions: [composition],
      bindings: [],
      targetProfiles: first.targetProfiles,
      ontologyDigest: first.ontologyDigest,
      policyDigest: first.policyDigest,
      compiler: first.compiler,
    });
    const run = await runCompilation({
      id: 'run-missing-provenance-source',
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
        {
          kind: 'fragment',
          id: secondFragment.id,
          bytesBase64: SECOND_SOURCE_BYTES.toString('base64'),
          contentDigest: SECOND_SOURCE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile(request) {
          return {
            ...testCompilerResponse(request),
            unresolvedReferences: [],
            omittedSubgraphs: [],
            conversionLoss: [],
          };
        },
      },
    });

    expect(run).toMatchObject({ status: 'failed', failureCode: 'missing_provenance_coverage' });
    expect(run.views).toEqual([]);
  });

  it('records a failed run and exposes no partial view after a digest mismatch', async () => {
    const basis = testBasis();
    const run = await runCompilation({
      id: 'run-failed',
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile(request) {
          return {
            ...testCompilerResponse(request),
            views: [
              {
                target: 'markdown',
                mediaType: 'text/markdown',
                bytesBase64: 'IyBUaXRsZQo=',
                contentDigest: ZERO_DIGEST,
              },
            ],
          };
        },
      },
    });

    expect(run.status).toBe('failed');
    expect(run.effectiveClassification).toBe('internal');
    expect(run.views).toEqual([]);
    expect(run.diagnostics).toMatchObject([{ code: 'view_digest_mismatch' }]);
    expect(run.failureCode).toBe('view_digest_mismatch');
    expect(run.failureMessage).toMatch(/bytes do not match/);
  });

  it('rejects undeclared compiler-input fields before invoking an adapter', async () => {
    const basis = testBasis();
    let invoked = false;
    const run = await runCompilation({
      id: 'run-extra-input-field',
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
          unboundInstruction: 'adapter-visible but absent from dependency digest',
        } as never,
      ],
      adapter: {
        identity: basis.compiler,
        async compile() {
          invoked = true;
          throw new Error('must not run');
        },
      },
    });

    expect(invoked).toBe(false);
    expect(run.status).toBe('failed');
    expect(run.diagnostics).toMatchObject([{ code: 'unexpected_field' }]);
  });

  it('rejects undeclared compiler-response envelope fields', async () => {
    const basis = testBasis();
    const run = await runCompilation({
      id: 'run-extra-response-field',
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile(request) {
          return {
            ...testCompilerResponse(request),
            excludedFromRunDigest: 'unbound compiler output',
          } as never;
        },
      },
    });

    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('unexpected_field');
    expect(run.failureMessage).toMatch(/compiler response.*excludedFromRunDigest/);
  });

  it.each([
    ['HIR provenance', 'hirProvenance'],
    ['CIR provenance', 'cirProvenance'],
    ['unresolved reference', 'unresolvedReferences'],
    ['omitted subgraph', 'omittedSubgraphs'],
    ['projection capability', 'projectionCapabilities'],
    ['diagnostic', 'diagnostics'],
    ['conversion loss', 'conversionLoss'],
    ['compiled view', 'views'],
  ] as const)('rejects undeclared fields in %s records', async (_recordType, responseField) => {
    const basis = testBasis();
    const run = await runCompilation({
      id: `run-extra-${responseField}-field`,
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile(request) {
          const response = testCompilerResponse(request);
          return {
            ...response,
            [responseField]: [
              {
                ...response[responseField][0],
                excludedFromRunDigest: 'unbound compiler output',
              },
            ],
          } as never;
        },
      },
    });

    expect(run.status).toBe('failed');
    expect(run.failureCode).toBe('unexpected_field');
    expect(run.failureMessage).toContain('excludedFromRunDigest');
  });

  it('keeps an unratified Liminal run draft-only', async () => {
    const basis = testBasis({
      kind: 'liminal',
      name: 'liminal-compiler',
      version: '0.1.0',
      protocol: 'kf-document-v1',
      commitSha: 'a'.repeat(40),
      cargoLockDigest: '4'.repeat(64),
      executableDigest: '5'.repeat(64),
      runtimeClosureDigest: '7'.repeat(64),
      qualification: { state: 'not_run', receiptDigest: null, ratified: false },
    });
    const run = await runCompilation({
      id: 'run-draft',
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile(request) {
          return {
            ...testCompilerResponse(request),
          };
        },
      },
    });

    expect(run.draftOnly).toBe(true);
    expect(() => assertCompilationMayBeAccepted(run)).toThrow(/draft-only/);
  });

  it('records qualified-Liminal failures without changing qualification-derived draft state', async () => {
    const basis = testBasis({
      kind: 'liminal',
      name: 'liminal-compiler',
      version: '1.0.0',
      protocol: 'kf-document-v1',
      commitSha: 'a'.repeat(40),
      cargoLockDigest: '4'.repeat(64),
      executableDigest: '5'.repeat(64),
      runtimeClosureDigest: '7'.repeat(64),
      qualification: { state: 'qualified', receiptDigest: '6'.repeat(64), ratified: true },
    });
    const run = await runCompilation({
      id: 'run-qualified-failure',
      basis,
      inputs: [
        {
          kind: 'fragment',
          id: 'fragment-revision-1',
          bytesBase64: 'IyBUaXRsZQo=',
          contentDigest: TITLE_DIGEST,
        },
      ],
      adapter: {
        identity: basis.compiler,
        async compile() {
          throw new Error('compiler process exited 17');
        },
      },
    });

    expect(run).toMatchObject({
      status: 'failed',
      draftOnly: false,
      failureCode: 'compiler_failed',
      failureMessage: 'compiler process exited 17',
    });
    expect(() => assertCompilationMayBeAccepted(run)).toThrow(/failed compilation/);
  });
});

describe('proposal overlays', () => {
  it('records immutable revision-preconditioned operations without becoming source', () => {
    const proposal = createProposalOverlay({
      id: 'proposal-1',
      subjectId: 'fragment-1',
      baseRevisionId: 'fragment-revision-1',
      basisId: 'basis-1',
      basisDigest: ZERO_DIGEST,
      kind: 'source_patch',
      proposedBy: {
        kind: 'model',
        provider: 'local',
        modelProfile: 'editor-v1',
        requestId: 'request-1',
      },
      modelProvenance: testModelProvenance(),
      operations: [
        {
          operation: 'replace_fragment_source',
          media_type: 'text/markdown',
          classification: 'internal',
          holder_id: 'holder-2',
          previous_holder_id: 'holder-1',
          holder: {
            kind: 'fabric_native',
            artifact_version_id: 'artifact-version-2',
            content_digest: TITLE_DIGEST,
          },
        },
      ],
      createdAt: '2026-08-14T12:00:00.000Z',
    });

    expect(proposal.proposalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(proposal.operations[0])).toBe(true);
    expect(Object.isFrozen(proposal.modelProvenance?.context.included_items[0])).toBe(true);
    expect(() =>
      createProposalOverlay({
        ...proposal,
        id: 'proposal-empty',
        operations: [],
      }),
    ).toThrow(/exactly one operation/);

    // Narrowed, not spread blind. `ProposalAuthor` is a union, and only its `model` arm has
    // a `provider` — overriding `provider` on a human author would add an inert key that
    // never reaches the provenance comparison, so the assertion below would be asserting
    // against a guard the input cannot trip. State the precondition and fail on it instead.
    const author = proposal.proposedBy;
    if (author.kind !== 'model') {
      throw new Error('fixture must be a model proposal for the provider-mismatch assertion');
    }
    expect(() =>
      createProposalOverlay({
        ...proposal,
        id: 'proposal-provider-mismatch',
        proposedBy: { ...author, provider: 'another-provider' },
      }),
    ).toThrow(/provider provenance/);
  });

  it('rejects calendar-invalid timestamps that only resemble RFC 3339', () => {
    expect(() =>
      createProposalOverlay({
        id: 'proposal-invalid-time',
        subjectId: 'fragment-1',
        baseRevisionId: 'fragment-revision-1',
        basisId: 'basis-1',
        basisDigest: ZERO_DIGEST,
        kind: 'source_patch',
        proposedBy: { kind: 'human', actorId: 'person-1' },
        modelProvenance: null,
        operations: [
          {
            operation: 'replace_fragment_source',
            media_type: 'text/markdown',
            classification: 'internal',
            holder_id: 'holder-2',
            previous_holder_id: 'holder-1',
            holder: {
              kind: 'fabric_native',
              artifact_version_id: 'artifact-version-2',
              content_digest: TITLE_DIGEST,
            },
          },
        ],
        createdAt: '2026-99-40T29:90:90.000Z',
      }),
    ).toThrow(/RFC 3339 UTC instant/);
  });
});
