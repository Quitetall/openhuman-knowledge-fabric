import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ActionRequest, type ObjectRow } from '@kf/actions';
import { digestOf, InMemoryObjectStore } from '@kf/artifacts';
import { canonicalize, digest } from '@kf/canonicalization';
import { setAccessContext, setTransactionContext, withTransaction, type Tx } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  artifactKindForDocumentClass,
  atomsFromPandoc,
  createAuthoredFragmentRevision,
  createCompilationBasis,
  createCompositionRevision,
  createDocumentActionAtoms,
  compileAdrProjections,
  mediaTypeForDocumentFile,
  PANDOC_PROJECTION_CONTRACT,
  projectionFromPandoc,
  validateParsedDocument,
} from './index.js';
import {
  seedFixtures,
  startHarness,
  createObject,
  bindContext,
  registerTestDocumentCompiler,
  type Fixtures,
  type Harness,
} from '../../../tests/database/harness.js';

const REQUIRED_DOCUMENT_ACTIONS = [
  'accept_document_compilation',
  'add_authored_fragment',
  'add_document_composition',
  'apply_document_proposal',
  'change_document_source_holder',
  'compile_master_record',
  'publish_document_view',
  'record_document_proposal',
  'request_document_compilation',
  'retire_authored_fragment',
  'revise_authored_fragment',
  'revise_document_composition',
] as const;

const ORGANIZATION_ID = '01950000-0000-7000-8000-000000000001';
const ACTOR_ID = '01950000-0000-7000-8000-000000000002';
const ROLE_ID = '01950000-0000-7000-8000-000000000003';
const TARGET_ID = '01950000-0000-7000-8000-000000000004';

function documentRequest(
  actionType: string,
  payload: Readonly<Record<string, never>> = {},
): ActionRequest {
  return {
    actionType,
    actorId: ACTOR_ID,
    actingRoleId: ROLE_ID,
    targetIds: [TARGET_ID],
    payload,
    idempotencyKey: `test-${actionType}`,
    organizationId: ORGANIZATION_ID,
    maxClassification: 'restricted',
  };
}

const fragmentObject: ObjectRow = {
  id: TARGET_ID,
  object_type: 'authored_fragment',
  lifecycle_state: 'active',
  row_version: '1',
  organization_id: ORGANIZATION_ID,
  created_by: ACTOR_ID,
};

function roleTx(roleId: string, scopeId: string): Tx {
  return {
    async maybeOne() {
      return { role_id: roleId, scope_id: scopeId };
    },
  } as unknown as Tx;
}

function policyAuthorityTx(
  policy: 'ordinary' | 'controlled' | 'regulated',
  qualityAssignment?: { readonly role_id: string; readonly scope_id: string },
): Tx {
  let roleRead = false;
  return {
    async maybeOne() {
      if (!roleRead) {
        roleRead = true;
        return { role_id: 'technical_authority', scope_id: ORGANIZATION_ID };
      }
      return qualityAssignment;
    },
    async one() {
      return { document_policy: policy };
    },
  } as unknown as Tx;
}

describe('document atoms', () => {
  it('compiles deterministic ADR projections from linked semantic records', () => {
    const projections = compileAdrProjections({
      decisions: [
        {
          decisionId: 'decision-1',
          enterpriseId: 'ADR-0002',
          title: 'Liminal-backed document compiler',
          lifecycleState: 'accepted',
        },
      ],
      bodies: [
        {
          decisionId: 'decision-1',
          documentRevisionId: 'revision-accepted',
          bodyState: 'accepted',
          bodyDigest: 'a'.repeat(64),
          recordedAt: '2026-08-15T00:00:00.000Z',
        },
      ],
      implementations: [
        {
          decisionId: 'decision-1',
          implementationKind: 'change',
          targetId: 'change-1',
          summary: 'Compiler migration work',
          recordedAt: '2026-08-15T00:01:00.000Z',
        },
      ],
      activity: [
        {
          decisionId: 'decision-1',
          sequenceNo: 1,
          progressKind: 'completed',
          summary: 'Local implementation complete',
          recordedAt: '2026-08-15T00:02:00.000Z',
        },
      ],
      verifications: [
        {
          decisionId: 'decision-1',
          testDefinitionId: 'gate-1',
          testExecutionId: null,
          executionState: 'not_run',
          recordedAt: '2026-08-15T00:03:00.000Z',
        },
        {
          decisionId: 'decision-1',
          testDefinitionId: 'gate-2',
          testExecutionId: 'execution-failed',
          executionState: 'failed',
          recordedAt: '2026-08-15T00:03:30.000Z',
        },
        {
          decisionId: 'decision-1',
          testDefinitionId: 'gate-2',
          testExecutionId: 'execution-passed',
          executionState: 'passed',
          recordedAt: '2026-08-15T00:03:45.000Z',
        },
      ],
      relations: [
        {
          sourceDecisionId: 'decision-1',
          targetDecisionId: 'decision-0',
          relationKind: 'extends',
          recordedAt: '2026-08-15T00:04:00.000Z',
        },
      ],
    });

    expect(projections.overview).toEqual([
      expect.objectContaining({
        decisionId: 'decision-1',
        acceptedDocumentRevisionId: 'revision-accepted',
        latestProgressKind: 'completed',
        activityCount: 1,
        gateDebtCount: 1,
      }),
    ]);
    expect(projections.workBoard[0]).toMatchObject({
      implementationCount: 1,
      verificationCount: 3,
      lastActivityAt: '2026-08-15T00:04:00.000Z',
    });
    expect(projections.topics[0]).toMatchObject({ topicKey: 'adr-0002' });
    expect(projections.gateDebt).toEqual([
      {
        decisionId: 'decision-1',
        testDefinitionId: 'gate-1',
        testExecutionId: null,
        debtKind: 'missing_execution',
      },
    ]);
  });

  it('exposes only narrow ADR document actions through the document action boundary', () => {
    const atoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const names = new Set([
      ...Object.keys(atoms.materializers),
      ...Object.keys(atoms.effects),
      ...Object.keys(atoms.preconditions),
    ]);

    for (const action of REQUIRED_DOCUMENT_ACTIONS) expect(names.has(action), action).toBe(true);
    expect(names.has('mutate_document')).toBe(false);
    expect(names.has('approve_decision')).toBe(false);
    expect(names.has('allocate_identifier')).toBe(false);
  });

  it('resolves document authority from active database role kind and exact scope', async () => {
    const atoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const check = atoms.preconditions.add_authored_fragment!;

    await expect(
      check(roleTx('finance_approver', ORGANIZATION_ID), documentRequest('add_authored_fragment'), [
        fragmentObject,
      ]),
    ).rejects.toMatchObject({
      failure: 'actor_not_authorized',
      detail: { rule: 'KF-DOC-AUTH-001' },
    });
    await expect(
      check(
        roleTx('technical_authority', '01950000-0000-7000-8000-000000000099'),
        documentRequest('add_authored_fragment'),
        [fragmentObject],
      ),
    ).rejects.toMatchObject({
      failure: 'actor_not_authorized',
      detail: { rule: 'KF-DOC-AUTH-002' },
    });
    await expect(
      check(
        roleTx('technical_authority', ORGANIZATION_ID),
        {
          ...documentRequest('add_authored_fragment'),
          payload: { document_policy: 'ordinary' },
        },
        [fragmentObject],
      ),
    ).resolves.toBeUndefined();
  });

  it('fails every document action closed before payload handling for an unheld role or wrong scope', async () => {
    const atoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    for (const action of REQUIRED_DOCUMENT_ACTIONS) {
      const check = atoms.preconditions[action]!;
      await expect(
        check(roleTx('finance_approver', ORGANIZATION_ID), documentRequest(action), [
          fragmentObject,
        ]),
        action,
      ).rejects.toMatchObject({
        failure: 'actor_not_authorized',
        detail: { rule: 'KF-DOC-AUTH-001' },
      });
      await expect(
        check(
          roleTx('technical_authority', '01950000-0000-7000-8000-000000000099'),
          documentRequest(action),
          [fragmentObject],
        ),
        action,
      ).rejects.toMatchObject({
        failure: 'actor_not_authorized',
        detail: { rule: 'KF-DOC-AUTH-002' },
      });
    }
  });

  it('requires scoped quality authority in addition to technical authority for controlled policy', async () => {
    const atoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });
    const check = atoms.preconditions.change_document_source_holder!;
    const request = {
      ...documentRequest('change_document_source_holder'),
      payload: {
        document_policy: 'controlled',
        quality_role_assignment_id: '01950000-0000-7000-8000-000000000008',
      },
    } satisfies ActionRequest;

    await expect(
      check(policyAuthorityTx('controlled'), request, [fragmentObject]),
    ).rejects.toMatchObject({
      failure: 'actor_not_authorized',
      detail: { rule: 'KF-DOC-AUTH-003' },
    });

    for (const action of ['accept_document_compilation', 'publish_document_view'] as const) {
      await expect(
        atoms.preconditions[action]!(
          policyAuthorityTx('regulated'),
          {
            ...documentRequest(action),
            payload: {
              document_policy: 'regulated',
              quality_role_assignment_id: '01950000-0000-7000-8000-000000000008',
            },
          },
          [fragmentObject],
        ),
        action,
      ).rejects.toMatchObject({
        failure: 'actor_not_authorized',
        detail: { rule: 'KF-DOC-AUTH-003' },
      });
    }
  });

  it('derives policy from the subject and rejects a caller downgrade assertion', async () => {
    const atoms = createDocumentActionAtoms({
      store: new InMemoryObjectStore(),
      parser: {
        async parse() {
          return undefined;
        },
      },
    });

    await expect(
      atoms.preconditions.change_document_source_holder!(
        policyAuthorityTx('controlled', {
          role_id: 'quality_authority',
          scope_id: ORGANIZATION_ID,
        }),
        {
          ...documentRequest('change_document_source_holder'),
          payload: {
            document_policy: 'ordinary',
            quality_role_assignment_id: '01950000-0000-7000-8000-000000000008',
          },
        },
        [fragmentObject],
      ),
    ).rejects.toMatchObject({
      failure: 'precondition_failed',
      detail: { rule: 'KF-DOC-POLICY-002' },
    });
  });

  it('maps document classes onto valid evidence-vault kinds', () => {
    expect(artifactKindForDocumentClass('specification')).toBe('specification');
    expect(artifactKindForDocumentClass('report')).toBe('report');
    expect(artifactKindForDocumentClass('record')).toBe('other');
  });

  it('infers browser-omitted text MIME types from supported file extensions', () => {
    expect(mediaTypeForDocumentFile('constitution.md', 'application/octet-stream')).toBe(
      'text/markdown',
    );
    expect(mediaTypeForDocumentFile('notes.txt', '')).toBe('text/plain');
    expect(mediaTypeForDocumentFile('scan.pdf', 'application/pdf')).toBeUndefined();
  });

  it('walks Pandoc Figure body rather than its caption tuple', () => {
    const atoms = atomsFromPandoc({
      blocks: [
        {
          t: 'Figure',
          c: [
            ['figure-id', [], []],
            [null, [{ t: 'Plain', c: [{ t: 'Str', c: 'Caption' }] }]],
            [{ t: 'Para', c: [{ t: 'Str', c: 'Body' }] }],
          ],
        },
      ],
    });
    expect(atoms.map((atom) => atom.text)).toEqual(['Body']);
  });

  it('reports every richer Pandoc claim that atom projection cannot retain', () => {
    const projected = projectionFromPandoc({
      meta: { title: { t: 'MetaString', c: 'Machine contract' } },
      blocks: [
        {
          t: 'Para',
          c: [{ t: 'Link', c: [['', [], []], [{ t: 'Str', c: 'source' }], ['https://x', '']] }],
        },
        { t: 'UnsupportedFutureBlock', c: [{ t: 'Str', c: 'not silently dropped' }] },
      ],
    });

    expect(projected.atoms.map((atom) => atom.text)).toEqual(['source']);
    expect(projected.conversionLoss).toEqual([
      expect.objectContaining({ code: 'pandoc_metadata_omitted', path: '/meta' }),
      expect.objectContaining({ code: 'pandoc_inline_projection', path: '/blocks/0/c/0' }),
      expect.objectContaining({ code: 'unsupported_pandoc_block', path: '/blocks/1' }),
    ]);
    expect(projected.conversionLoss.every((loss) => /^[0-9a-f]{64}$/.test(loss.sourceDigest))).toBe(
      true,
    );
  });

  it('preserves ordered-list start and raw-block format when atom fields can represent them', () => {
    const projected = projectionFromPandoc({
      blocks: [
        {
          t: 'OrderedList',
          c: [[4], [[{ t: 'Plain', c: [{ t: 'Str', c: 'Fourth' }] }]]],
        },
        { t: 'RawBlock', c: ['html', '<aside>Exact</aside>'] },
      ],
    });

    expect(projected.atoms).toEqual([
      expect.objectContaining({ text: 'Fourth', attributes: { list: 'ordered', order: 4 } }),
      expect.objectContaining({
        text: '<aside>Exact</aside>',
        attributes: { source: 'raw-block', format: 'html' },
      }),
    ]);
  });

  it('turns one document into ordered, independently hashed atoms', () => {
    const atoms = atomsFromPandoc({
      'pandoc-api-version': [1, 23, 1],
      meta: {},
      blocks: [
        { t: 'Header', c: [1, ['scope', [], []], [{ t: 'Str', c: 'Scope' }]] },
        {
          t: 'Para',
          c: [
            { t: 'Str', c: 'One' },
            { t: 'Space' },
            { t: 'Strong', c: [{ t: 'Str', c: 'fact' }] },
            { t: 'Space' },
            { t: 'Str', c: 'once.' },
          ],
        },
        {
          t: 'BulletList',
          c: [
            [{ t: 'Plain', c: [{ t: 'Str', c: 'Auditable' }] }],
            [{ t: 'Plain', c: [{ t: 'Str', c: 'Reusable' }] }],
          ],
        },
      ],
    });

    expect(atoms.map(({ ordinal, kind, level, text }) => ({ ordinal, kind, level, text }))).toEqual(
      [
        { ordinal: 1, kind: 'heading', level: 1, text: 'Scope' },
        { ordinal: 2, kind: 'paragraph', level: null, text: 'One fact once.' },
        { ordinal: 3, kind: 'list_item', level: 1, text: 'Auditable' },
        { ordinal: 4, kind: 'list_item', level: 1, text: 'Reusable' },
      ],
    );
    expect(atoms.every((atom) => /^[0-9a-f]{64}$/.test(atom.digest))).toBe(true);
    expect(new Set(atoms.map((atom) => atom.digest)).size).toBe(atoms.length);
  });

  it('rejects parser receipts whose source, atom, loss, or projection digest lacks its preimage', () => {
    const source = Buffer.from('# Title\n');
    const valid = {
      parser: 'fixture',
      parserVersion: '1.0.0',
      projectionContract: PANDOC_PROJECTION_CONTRACT,
      sourceDigest: 'e01b17ff9af77056792f67c57e3d1908795b9d1ae4cfe72421d0a2838991b740',
      atoms: [
        {
          ordinal: 1,
          kind: 'heading' as const,
          level: 1,
          text: 'Title',
          attributes: {},
          digest: '0dc5c1997e1a8d452a41403404c7487e26c729d392755ef115bbaa06cff65697',
        },
      ],
      conversionLoss: [],
      lossDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      contentDigest: '56037c158bffc40a5833337e3c0d200b7cf979e3355c51a345c2b83d055dd49c',
    };

    expect(validateParsedDocument(valid, source)).toEqual(valid);
    expect(() =>
      validateParsedDocument({ ...valid, sourceDigest: '0'.repeat(64) }, source),
    ).toThrow(/source digest/i);
    expect(() =>
      validateParsedDocument(
        { ...valid, atoms: [{ ...valid.atoms[0]!, digest: '0'.repeat(64) }] },
        source,
      ),
    ).toThrow(/atom digest/i);
    expect(() => validateParsedDocument({ ...valid, lossDigest: '0'.repeat(64) }, source)).toThrow(
      /loss digest/i,
    );
    expect(() =>
      validateParsedDocument({ ...valid, contentDigest: '0'.repeat(64) }, source),
    ).toThrow(/projection digest/i);
  });
});

describe('document action chain', () => {
  let harness: Harness;
  let fixtures: Fixtures;
  let store: InMemoryObjectStore;
  let execute: ReturnType<typeof createFabricDispatcher>;
  let qualityRoleAssignmentId: string;
  let sequence = 0;

  const hexDigest = (value: string): string => value.repeat(64);
  const commit = (value: string): string => value.repeat(40);
  const uuid = (): string => {
    sequence += 1;
    return `01950000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
  };

  const modelProvenance = (
    basisId: string,
    subjectId: string,
    revisionId: string,
    contentDigest: string,
  ) => {
    const contextClaim = {
      tokenizer: 'fixture-tokenizer-v1',
      token_budget: 64,
      instruction_digest: hexDigest('9'),
      included_items: [
        {
          subject_id: subjectId,
          revision_id: revisionId,
          classification: 'internal' as const,
          kind: 'document' as const,
          token_count: 16,
          content_digest: contentDigest,
          provenance_digest: hexDigest('8'),
        },
      ],
      omitted_subject_ids: [] as string[],
    };
    return {
      request_id: 'request-test-only',
      basis_id: basisId,
      classification: 'internal' as const,
      provider: {
        provider_id: 'local-test',
        model_id: 'deterministic-fixture',
        locality: 'local' as const,
      },
      policy: {
        policy_id: 'fixture-local-policy-v1',
        decision: { locality: 'local' as const, classification_ceiling: 'internal' as const },
      },
      context: { ...contextClaim, context_digest: digest(contextClaim) },
    };
  };

  beforeAll(async () => {
    harness = await startHarness();
    fixtures = await seedFixtures(harness.adminPool);
    store = new InMemoryObjectStore();
    execute = createFabricDispatcher(
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
    qualityRoleAssignmentId = await createObject(harness.adminPool, fixtures, {
      type: 'role_assignment',
      domain: 'organization',
      state: 'active',
      title: 'Document quality authority assignment',
      createdBy: fixtures.reviewerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        `insert into org.role_assignment (id, subject_id, role_id, scope_id)
         values ($1,$2,'quality_authority',$3)`,
        [qualityRoleAssignmentId, fixtures.reviewerId, fixtures.organizationId],
      );
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.stop();
  });

  function call(
    actionType: string,
    targetIds: readonly string[],
    payload: Readonly<Record<string, unknown>>,
    authority: 'author' | 'technical' = 'technical',
    reason?: string,
  ) {
    sequence += 1;
    return execute({
      actionType,
      actorId: authority === 'technical' ? fixtures.reviewerId : fixtures.performerId,
      actingRoleId: authority === 'technical' ? fixtures.reviewerRoleId : fixtures.performerRoleId,
      targetIds,
      payload,
      reason,
      idempotencyKey: `document-action-${actionType}-${sequence}`,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
    } as ActionRequest);
  }

  it('fails attach_evidence closed before parser-authored digests can persist', async () => {
    const source = Buffer.from('# Title\n');
    const sourceDigest = digestOf(source);
    const key = `parser-integrity/${sourceDigest}`;
    await store.put(key, source, 'text/markdown');
    const forgedExecute = createFabricDispatcher(
      harness.pool,
      createDocumentActionAtoms({
        store,
        parser: {
          async parse() {
            return {
              parser: 'forged-parser',
              parserVersion: '1.0.0',
              projectionContract: PANDOC_PROJECTION_CONTRACT,
              sourceDigest,
              atoms: [
                {
                  ordinal: 1,
                  kind: 'heading',
                  level: 1,
                  text: 'Title',
                  attributes: {},
                  digest: hexDigest('0'),
                },
              ],
              conversionLoss: [],
              lossDigest: digest([]),
              contentDigest: hexDigest('1'),
            };
          },
        },
      }),
    );

    await expect(
      forgedExecute({
        actionType: 'attach_evidence',
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        targetIds: [],
        payload: {
          title: 'forged-parser.md',
          artifact_kind: 'specification',
          sha256: sourceDigest,
          size_bytes: source.length,
          media_type: 'text/markdown',
          storage_uri: key,
        },
        idempotencyKey: `parser-integrity-${uuid()}`,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      }),
    ).rejects.toThrow(/atom digest mismatch/i);
  });

  it('persists exact source, atom, loss, and projection preimages as one verified parse', async () => {
    const source = Buffer.from('# Title\n');
    const sourceDigest = digestOf(source);
    const key = `parser-preimage/${sourceDigest}`;
    await store.put(key, source, 'text/markdown');
    const parserExecute = createFabricDispatcher(
      harness.pool,
      createDocumentActionAtoms({
        store,
        parser: {
          async parse() {
            return {
              parser: 'fixture-parser',
              parserVersion: '1.0.0',
              projectionContract: PANDOC_PROJECTION_CONTRACT,
              sourceDigest,
              atoms: [
                {
                  ordinal: 1,
                  kind: 'heading',
                  level: 1,
                  text: 'Title',
                  attributes: {},
                  digest: '0dc5c1997e1a8d452a41403404c7487e26c729d392755ef115bbaa06cff65697',
                },
              ],
              conversionLoss: [],
              lossDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
              contentDigest: '56037c158bffc40a5833337e3c0d200b7cf979e3355c51a345c2b83d055dd49c',
            };
          },
        },
      }),
    );
    const result = await parserExecute({
      actionType: 'attach_evidence',
      actorId: fixtures.reviewerId,
      actingRoleId: fixtures.reviewerRoleId,
      targetIds: [],
      payload: {
        title: 'verified-parser.md',
        artifact_kind: 'specification',
        sha256: sourceDigest,
        size_bytes: source.length,
        media_type: 'text/markdown',
        storage_uri: key,
      },
      idempotencyKey: `parser-preimage-${uuid()}`,
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
    });
    const stored = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return tx.one<{
        source_digest: string;
        loss_digest: string;
        content_digest: string;
        projection_preimage: string;
        atom_preimage: string;
      }>(
        `select p.source_digest, p.loss_digest, p.content_digest, p.projection_preimage,
                a.atom_preimage
           from content.artifact_version v
           join content.document_parse p on p.artifact_version_id = v.id
           join content.document_atom a on a.parse_id = p.id
          where v.artifact_id = $1`,
        [result.objectIds[0]],
      );
    });

    expect(stored).toEqual({
      source_digest: sourceDigest,
      loss_digest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      content_digest: '56037c158bffc40a5833337e3c0d200b7cf979e3355c51a345c2b83d055dd49c',
      projection_preimage:
        '{"atoms":[{"attributes":{},"kind":"heading","level":1,"ordinal":1,"text":"Title"}],"conversionLoss":[],"projectionContract":"kf.pandoc-atoms.v2"}',
      atom_preimage: '{"attributes":{},"kind":"heading","level":1,"ordinal":1,"text":"Title"}',
    });
  });

  it('records ADR body links through decision dispatcher effects', async () => {
    const fragmentHolderId = uuid();
    const fragmentRevisionId = uuid();
    const fragmentDigest = hexDigest('a');
    await call(
      'add_authored_fragment',
      [],
      {
        title: 'ADR decision body source',
        stable_key: 'adr.body.source',
        holder_id: fragmentHolderId,
        holder: {
          kind: 'git',
          repository: 'local/openhuman',
          commit_sha: commit('a'),
          path: 'docs/decisions/0002.md',
          submodule_commit_sha: null,
          content_digest: fragmentDigest,
        },
        revision_id: fragmentRevisionId,
        media_type: 'text/markdown',
        classification: 'internal',
        document_policy: 'ordinary',
      },
      'technical',
    );

    const proposed = await call(
      'propose_decision',
      [],
      {
        title: 'ADR-0002 document compiler',
        document_revision_id: fragmentRevisionId,
        body_state: 'draft',
        body_digest: fragmentDigest,
      },
      'technical',
    );
    const decisionId = proposed.objectIds[0]!;
    const accepted = await call(
      'accept_decision',
      [decisionId],
      {
        document_revision_id: fragmentRevisionId,
        body_state: 'accepted',
        body_digest: fragmentDigest,
      },
      'technical',
    );

    const rows = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return tx.query<{
        body_state: string;
        body_digest: string;
        recorded_by_action: string;
        action_type: string;
      }>(
        `select body.body_state, body.body_digest, body.recorded_by_action::text,
                action.action_type
           from content.adr_decision_body body
           join core.action action on action.id = body.recorded_by_action
          where body.decision_id = $1
          order by body.body_state`,
        [decisionId],
      );
    });

    expect(rows).toEqual([
      {
        body_state: 'accepted',
        body_digest: fragmentDigest,
        recorded_by_action: accepted.actionId,
        action_type: 'accept_decision',
      },
      {
        body_state: 'draft',
        body_digest: fragmentDigest,
        recorded_by_action: proposed.actionId,
        action_type: 'propose_decision',
      },
    ]);

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query(
          `update content.adr_decision_body
              set body_digest = $2
            where decision_id = $1`,
          [decisionId, hexDigest('c')],
        );
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('delete from content.adr_decision_body where decision_id = $1', [
          decisionId,
        ]);
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('truncate content.adr_decision_body');
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('keeps ADR implementation activity as immutable audit history after current state changes', async () => {
    const fragmentHolderId = uuid();
    const fragmentRevisionId = uuid();
    const fragmentDigest = hexDigest('b');
    await call(
      'add_authored_fragment',
      [],
      {
        title: 'ADR immutable activity source',
        stable_key: 'adr.immutable.activity.source',
        holder_id: fragmentHolderId,
        holder: {
          kind: 'git',
          repository: 'local/openhuman',
          commit_sha: commit('b'),
          path: 'docs/decisions/immutable-activity.md',
          submodule_commit_sha: null,
          content_digest: fragmentDigest,
        },
        revision_id: fragmentRevisionId,
        media_type: 'text/markdown',
        classification: 'internal',
        document_policy: 'ordinary',
      },
      'technical',
    );

    const proposed = await call(
      'propose_decision',
      [],
      {
        title: 'ADR immutable progress history',
        document_revision_id: fragmentRevisionId,
        body_state: 'draft',
        body_digest: fragmentDigest,
      },
      'technical',
    );
    const decisionId = proposed.objectIds[0]!;
    await call(
      'accept_decision',
      [decisionId],
      {
        document_revision_id: fragmentRevisionId,
        body_state: 'accepted',
        body_digest: fragmentDigest,
      },
      'technical',
    );

    const opened = await call(
      'open_change',
      [],
      {
        title: 'Implement immutable ADR activity',
        decision_id: decisionId,
      },
      'technical',
    );
    const changeId = opened.objectIds[0]!;
    await call('approve_change', [changeId], { to_state: 'approved' }, 'technical');
    await call('approve_change', [changeId], {}, 'technical');
    await call('verify_change', [changeId], {}, 'technical');
    await call('make_change_effective', [changeId], {}, 'technical');

    const readActivity = () =>
      withTransaction(harness.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        return tx.query<{
          sequence_no: number;
          progress_kind: string;
          summary: string;
          change_id: string | null;
          action_type: string | null;
        }>(
          `select activity.sequence_no, activity.progress_kind, activity.summary,
                  activity.change_id::text,
                  action.action_type
             from content.adr_activity activity
             left join core.action action on action.id = activity.recorded_by_action
            where activity.decision_id = $1
              and activity.change_id = $2
            order by activity.sequence_no`,
          [decisionId, changeId],
        );
      });

    const beforeMutation = await readActivity();
    expect(beforeMutation.map((row) => row.action_type)).toEqual([
      null,
      'open_change',
      'approve_change',
      'approve_change',
      'verify_change',
      'make_change_effective',
    ]);
    expect(beforeMutation.map((row) => row.progress_kind)).toEqual([
      'progress',
      'progress',
      'progress',
      'progress',
      'completed',
      'completed',
    ]);
    expect(beforeMutation.map((row) => row.summary)).toEqual([
      'ADR implementation linked',
      'ADR implementation action open_change',
      'ADR implementation action approve_change',
      'ADR implementation action approve_change',
      'ADR implementation action verify_change',
      'ADR implementation action make_change_effective',
    ]);

    await withTransaction(harness.adminPool, async (tx) => {
      await tx.query('set local session_replication_role = replica');
      await tx.query(
        `update core.object
            set lifecycle_state = 'closed',
                row_version = row_version + 1
          where id = $1`,
        [changeId],
      );
      await tx.query(
        `update core.relation
            set state = 'inactive',
                valid_to = now()
          where relation_type = 'implements'
            and source_id = $1
            and target_id = $2`,
        [changeId, decisionId],
      );
    });

    const afterMutation = await readActivity();
    expect(afterMutation).toEqual(beforeMutation);

    const predecessor = await call(
      'propose_decision',
      [],
      {
        title: 'ADR predecessor decision',
        document_revision_id: fragmentRevisionId,
        body_state: 'draft',
        body_digest: fragmentDigest,
      },
      'technical',
    );
    const predecessorId = predecessor.objectIds[0]!;
    await call(
      'accept_decision',
      [predecessorId],
      {
        document_revision_id: fragmentRevisionId,
        body_state: 'accepted',
        body_digest: fragmentDigest,
      },
      'technical',
    );
    const relationId = await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      const row = await tx.one<{ id: string }>(
        `insert into core.relation (relation_type, source_id, target_id, created_by)
         values ('supersedes', $1, $2, $3)
         returning id::text`,
        [decisionId, predecessorId, fixtures.reviewerId],
      );
      return row.id;
    });
    const readRelationActivity = () =>
      withTransaction(harness.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        return tx.query<{
          sequence_no: number;
          progress_kind: string;
          summary: string;
        }>(
          `select sequence_no, progress_kind, summary
             from content.adr_activity
            where decision_id = $1
              and summary = 'ADR relation supersedes'
            order by sequence_no`,
          [decisionId],
        );
      });

    const relationActivityBeforeMutation = await readRelationActivity();
    expect(relationActivityBeforeMutation).toEqual([
      expect.objectContaining({
        progress_kind: 'completed',
        summary: 'ADR relation supersedes',
      }),
    ]);
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        `update core.relation
            set state = 'inactive',
                valid_to = now()
          where id = $1`,
        [relationId],
      );
    });
    expect(await readRelationActivity()).toEqual(relationActivityBeforeMutation);
  });

  it('reports ADR gate debt from the latest execution per test definition', async () => {
    const fragmentHolderId = uuid();
    const fragmentRevisionId = uuid();
    const fragmentDigest = hexDigest('d');
    await call(
      'add_authored_fragment',
      [],
      {
        title: 'ADR gate debt source',
        stable_key: 'adr.gate.debt.source',
        holder_id: fragmentHolderId,
        holder: {
          kind: 'git',
          repository: 'local/openhuman',
          commit_sha: commit('d'),
          path: 'docs/decisions/gate-debt.md',
          submodule_commit_sha: null,
          content_digest: fragmentDigest,
        },
        revision_id: fragmentRevisionId,
        media_type: 'text/markdown',
        classification: 'internal',
        document_policy: 'ordinary',
      },
      'technical',
    );
    const proposed = await call(
      'propose_decision',
      [],
      {
        title: 'ADR gate debt latest execution',
        document_revision_id: fragmentRevisionId,
        body_state: 'draft',
        body_digest: fragmentDigest,
      },
      'technical',
    );
    const decisionId = proposed.objectIds[0]!;
    await call(
      'accept_decision',
      [decisionId],
      {
        document_revision_id: fragmentRevisionId,
        body_state: 'accepted',
        body_digest: fragmentDigest,
      },
      'technical',
    );

    const definitionId = await createObject(harness.adminPool, fixtures, {
      type: 'test_definition',
      domain: 'engineering',
      state: 'approved',
      title: 'ADR latest gate',
      createdBy: fixtures.reviewerId,
    });
    const failedExecutionId = await createObject(harness.adminPool, fixtures, {
      type: 'test_execution',
      domain: 'engineering',
      state: 'failed',
      title: 'ADR failed gate run',
      createdBy: fixtures.reviewerId,
    });
    const passedExecutionId = await createObject(harness.adminPool, fixtures, {
      type: 'test_execution',
      domain: 'engineering',
      state: 'passed',
      title: 'ADR passed gate run',
      createdBy: fixtures.reviewerId,
    });
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        `insert into engineering.test_definition
             (id, method_kind, acceptance_criterion, verifies)
           values ($1, 'test', 'ADR acceptance gate passes.', $2)`,
        [definitionId, decisionId],
      );
      await tx.query(
        `insert into engineering.test_execution (id, test_definition, executed_on, result_summary)
         values ($1, $3, timestamp with time zone '2026-08-15 12:00:00+00', 'failed'),
                ($2, $3, timestamp with time zone '2026-08-15 12:05:00+00', 'passed')`,
        [failedExecutionId, passedExecutionId, definitionId],
      );
      await tx.query('set local session_replication_role = replica');
      await tx.query(
        `update core.object
            set updated_at = case id
                  when $1 then timestamp with time zone '2026-08-15 12:00:00+00'
                  when $2 then timestamp with time zone '2026-08-15 12:05:00+00'
                  else updated_at
                end,
                row_version = row_version + 1
          where id = any($3::uuid[])`,
        [failedExecutionId, passedExecutionId, [failedExecutionId, passedExecutionId]],
      );
    });

    const readGateDebt = () =>
      withTransaction(harness.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        return tx.query<{ test_execution_id: string | null; debt_kind: string }>(
          `select test_execution_id::text, debt_kind
             from content.adr_gate_debt
            where decision_id = $1
              and test_definition_id = $2
            order by test_execution_id nulls first`,
          [decisionId, definitionId],
        );
      });

    expect(await readGateDebt()).toEqual([]);
    await withTransaction(harness.adminPool, async (tx) => {
      await tx.query('set local session_replication_role = replica');
      await tx.query(
        `update core.object
            set lifecycle_state = 'invalidated',
                updated_at = timestamp with time zone '2026-08-15 12:10:00+00',
                row_version = row_version + 1
          where id = $1`,
        [passedExecutionId],
      );
    });
    expect(await readGateDebt()).toEqual([
      {
        test_execution_id: passedExecutionId,
        debt_kind: 'invalidated',
      },
    ]);
  });

  it('materializes every narrow action without generic write, approval, or identifier authority', async () => {
    const fragmentHolderId = uuid();
    const fragmentRevision1Id = uuid();
    const fragmentDigest1 = hexDigest('1');
    const fragment = await call(
      'add_authored_fragment',
      [],
      {
        title: 'Constitution purpose',
        stable_key: 'constitution.purpose',
        holder_id: fragmentHolderId,
        holder: {
          kind: 'git',
          repository: 'local/openhuman',
          commit_sha: commit('a'),
          path: 'docs/atoms/purpose.md',
          submodule_commit_sha: null,
          content_digest: fragmentDigest1,
        },
        revision_id: fragmentRevision1Id,
        media_type: 'text/markdown',
        classification: 'internal',
        document_policy: 'controlled',
        quality_role_assignment_id: qualityRoleAssignmentId,
      },
      'technical',
    );
    const fragmentId = fragment.objectIds[0]!;

    await expect(
      call(
        'change_document_source_holder',
        [fragmentId],
        {
          document_policy: 'ordinary',
          holder_id: uuid(),
          previous_holder_id: fragmentHolderId,
          reversible_migration_plan: 'Restore prior immutable Holder.',
          holder: {
            kind: 'git',
            repository: 'local/openhuman',
            commit_sha: commit('b'),
            path: 'docs/atoms/purpose.md',
            submodule_commit_sha: null,
            content_digest: hexDigest('2'),
          },
        },
        'technical',
        'Move source to reviewed revision.',
      ),
    ).rejects.toMatchObject({ detail: { rule: 'KF-DOC-POLICY-002' } });

    await expect(
      call(
        'change_document_source_holder',
        [fragmentId],
        {
          document_policy: 'controlled',
          holder_id: uuid(),
          previous_holder_id: fragmentHolderId,
          reversible_migration_plan: 'Restore prior immutable Holder.',
          holder: {
            kind: 'git',
            repository: 'local/openhuman',
            commit_sha: commit('b'),
            path: 'docs/atoms/purpose.md',
            submodule_commit_sha: null,
            content_digest: hexDigest('2'),
          },
        },
        'technical',
        'Move source to reviewed revision.',
      ),
    ).rejects.toMatchObject({ detail: { rule: 'KF-DOC-AUTH-003' } });

    const fragmentHolder2Id = uuid();
    const fragmentDigest2 = hexDigest('2');
    const holderChanged = await call(
      'change_document_source_holder',
      [fragmentId],
      {
        document_policy: 'controlled',
        quality_role_assignment_id: qualityRoleAssignmentId,
        holder_id: fragmentHolder2Id,
        previous_holder_id: fragmentHolderId,
        reversible_migration_plan: 'Restore prior immutable Holder.',
        holder: {
          kind: 'git',
          repository: 'local/openhuman',
          commit_sha: commit('b'),
          path: 'docs/atoms/purpose.md',
          submodule_commit_sha: null,
          content_digest: fragmentDigest2,
        },
      },
      'technical',
      'Move source to reviewed revision.',
    );

    await expect(
      withTransaction(harness.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        await setTransactionContext(tx, {
          actorId: fixtures.reviewerId,
          actingRoleId: fixtures.reviewerRoleId,
          actionId: holderChanged.actionId,
        });
        await tx.query(
          'update content.document_subject set current_holder_id = $2 where object_id = $1',
          [fragmentId, fragmentHolderId],
        );
      }),
    ).rejects.toThrow(/exact open typed action context/i);

    const divergentActionId = uuid();
    const divergentHolderId = uuid();
    const divergentRequestId = `divergent-holder-${divergentActionId}`;
    await expect(
      withTransaction(harness.pool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        await setTransactionContext(tx, {
          actorId: fixtures.reviewerId,
          actingRoleId: fixtures.reviewerRoleId,
          actionId: divergentActionId,
          requestId: divergentRequestId,
        });
        await tx.query(
          `insert into core.action
             (id, action_type, actor_id, acting_role_id, target_ids, parameters,
              preconditions, idempotency_key, effective_at, request_id, reason,
              result_status, result, organization_id, request_digest)
           values ($1,'change_document_source_holder',$2,$3,$4,$5,'{}',$6,date_trunc('milliseconds', now()),$7,$8,
                   'applied','{}',$9,$10)`,
          [
            divergentActionId,
            fixtures.reviewerId,
            fixtures.reviewerRoleId,
            [fragmentId],
            JSON.stringify({
              holder_id: divergentHolderId,
              previous_holder_id: fragmentHolder2Id,
              reversible_migration_plan: 'Restore prior immutable Holder.',
              holder: {
                kind: 'git',
                repository: 'local/openhuman',
                commit_sha: commit('3'),
                path: 'docs/atoms/purpose.md',
                submodule_commit_sha: null,
                content_digest: hexDigest('3'),
              },
            }),
            `divergent-holder-${divergentActionId}`,
            divergentRequestId,
            'Attempt divergent direct row.',
            fixtures.organizationId,
            hexDigest('7'),
          ],
        );
        await tx.query(
          `insert into content.document_source_holder
             (id, subject_id, previous_holder_id, holder_kind, git_repository,
              git_commit_sha, git_path, content_digest, migration_reason,
              reversible_migration_plan, recorded_by, recorded_by_action)
           values ($1,$2,$3,'git','local/openhuman',$4,'docs/atoms/purpose.md',$5,$6,$7,$8,$9)`,
          [
            divergentHolderId,
            fragmentId,
            fragmentHolder2Id,
            commit('3'),
            hexDigest('4'),
            'Attempt divergent direct row.',
            'Restore prior immutable Holder.',
            fixtures.reviewerId,
            divergentActionId,
          ],
        );
      }),
    ).rejects.toThrow(/Holder differs from exact action parameters/i);

    const fragmentRevision2Id = uuid();
    const fragmentRevisionHolderId = uuid();
    const fragmentRevisionDigest = hexDigest('e');
    await call(
      'revise_authored_fragment',
      [fragmentId],
      {
        revision_id: fragmentRevision2Id,
        previous_revision_id: fragmentRevision1Id,
        holder_id: fragmentRevisionHolderId,
        previous_holder_id: fragmentHolder2Id,
        holder: {
          kind: 'git',
          repository: 'local/openhuman',
          commit_sha: commit('e'),
          path: 'docs/atoms/purpose.md',
          submodule_commit_sha: null,
          content_digest: fragmentRevisionDigest,
        },
        media_type: 'text/markdown',
        classification: 'internal',
        quality_role_assignment_id: qualityRoleAssignmentId,
      },
      'technical',
    );

    const compositionRevision1Id = uuid();
    const compositionHolderId = uuid();
    const composition = await call(
      'add_document_composition',
      [],
      {
        title: 'Document Constitution',
        stable_key: 'constitution',
        holder_id: compositionHolderId,
        holder: {
          kind: 'git',
          repository: 'local/openhuman',
          commit_sha: commit('c'),
          path: 'docs/compose.toml',
          submodule_commit_sha: null,
          content_digest: hexDigest('3'),
        },
        revision_id: compositionRevision1Id,
        classification: 'internal',
        document_policy: 'ordinary',
        inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: fragmentRevision2Id }],
      },
      'author',
    );
    const compositionId = composition.objectIds[0]!;

    const compositionRevision2Id = uuid();
    const compositionRevisionHolderId = uuid();
    await call(
      'revise_document_composition',
      [compositionId],
      {
        revision_id: compositionRevision2Id,
        previous_revision_id: compositionRevision1Id,
        holder_id: compositionRevisionHolderId,
        previous_holder_id: compositionHolderId,
        holder: {
          kind: 'git',
          repository: 'local/openhuman',
          commit_sha: commit('f'),
          path: 'docs/compose.toml',
          submodule_commit_sha: null,
          content_digest: hexDigest('f'),
        },
        classification: 'internal',
        inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: fragmentRevision2Id }],
      },
      'author',
    );

    const fragmentRevision = createAuthoredFragmentRevision({
      id: fragmentRevision2Id,
      fragmentId,
      previousRevisionId: fragmentRevision1Id,
      mediaType: 'text/markdown',
      classification: 'internal',
      state: 'active',
      holder: {
        kind: 'git',
        subjectId: fragmentId,
        repository: 'local/openhuman',
        commitSha: commit('e'),
        path: 'docs/atoms/purpose.md',
        submoduleCommitSha: null,
        contentDigest: fragmentRevisionDigest,
      },
    });
    const compositionRevision2 = createCompositionRevision({
      id: compositionRevision2Id,
      compositionId,
      previousRevisionId: compositionRevision1Id,
      classification: 'internal',
      inputs: [{ ordinal: 1, role: 'fragment', fragmentRevisionId: fragmentRevision2Id }],
    });
    const compiler = {
      kind: 'liminal' as const,
      name: 'synthetic-test-compiler',
      version: 'test-only',
      protocol: 'kf-document-v1' as const,
      commitSha: commit('d'),
      cargoLockDigest: hexDigest('7'),
      executableDigest: hexDigest('8'),
      runtimeClosureDigest: hexDigest('a'),
      qualification: {
        state: 'qualified' as const,
        receiptDigest: hexDigest('9'),
        ratified: true,
      },
    };
    const compilerRegistrationId = await registerTestDocumentCompiler(
      harness.adminPool,
      compiler,
      fixtures.reviewerId,
    );
    const basis = createCompilationBasis({
      protocol: 'kf-document-v1',
      rootCompositionRevisionId: compositionRevision2Id,
      fragmentRevisions: [fragmentRevision],
      compositionRevisions: [compositionRevision2],
      bindings: [],
      targetProfiles: [{ target: 'html', profileDigest: hexDigest('4') }],
      ontologyDigest: hexDigest('5'),
      policyDigest: hexDigest('6'),
      compiler,
    });
    const basisId = uuid();
    const requested = await call('request_document_compilation', [compositionId], {
      basis_id: basisId,
      basis,
    });

    await withTransaction(harness.adminPool, async (tx) => {
      await tx.query('set local role kf_app');
      await setAccessContext(tx, {
        organizationId: uuid(),
        maxClassification: 'restricted',
      });
      const hidden = await tx.one<{ visible_basis_count: number; compiler_enabled: boolean }>(
        `select
           (select count(*)::integer from content.compilation_basis where id = $2)
             as visible_basis_count,
           content.document_compiler_enabled($1, $2) as compiler_enabled`,
        [compilerRegistrationId, basisId],
      );
      expect(hidden).toEqual({ visible_basis_count: 0, compiler_enabled: false });
    });

    const viewBytes = Buffer.from('<h1>Document Constitution</h1>');
    const viewDigest = digestOf(viewBytes);
    const storageKey = `test-compiled-views/${viewDigest}`;
    await store.put(storageKey, viewBytes, 'text/html');
    const viewArtifact = await call('attach_evidence', [], {
      title: 'constitution.html',
      artifact_kind: 'report',
      sha256: viewDigest,
      size_bytes: viewBytes.length,
      media_type: 'text/html',
      storage_uri: storageKey,
    });
    const artifactVersionId = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return (
        await tx.one<{ id: string }>(
          'select id from content.artifact_version where artifact_id = $1',
          [viewArtifact.objectIds[0]],
        )
      ).id;
    });

    const runId = uuid();
    const viewId = uuid();
    const compilerDigest = hexDigest('a');
    const dependencyDigest = hexDigest('b');
    const semanticGraph = { kind: 'document', title: 'Document Constitution' };
    const semanticDigest = digest(semanticGraph);
    const hirProvenance = [
      {
        nodeId: 'hir:test',
        sourceKind: 'fragment',
        sourceId: fragmentRevision2Id,
        sourcePath: null,
        sourceDigest: fragmentRevisionDigest,
      },
    ];
    const cirProvenance = [
      {
        nodeId: 'cir:test',
        sourceKind: 'fragment',
        sourceId: fragmentRevision2Id,
        sourcePath: null,
        sourceDigest: fragmentRevisionDigest,
      },
    ];
    const runPreimage = {
      format: 'kf-document-compilation-run-v2',
      id: runId,
      basisDigest: basis.basisDigest,
      compilerDigest,
      dependencyDigest,
      status: 'succeeded',
      draftOnly: false,
      effectiveClassification: 'internal',
      semanticGraph,
      semanticDigest,
      hirProvenance,
      cirProvenance,
      unresolvedReferences: [],
      omittedSubgraphs: [],
      projectionCapabilities: [],
      failureCode: null,
      failureMessage: null,
      diagnostics: [],
      conversionLoss: [],
      views: [
        {
          target: 'html',
          mediaType: 'text/html',
          contentDigest: viewDigest,
          effectiveClassification: 'internal',
        },
      ],
    } as const;
    const canonicalRunPreimage = canonicalize(runPreimage);
    const runDigest = digest(runPreimage);
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        await setTransactionContext(tx, {
          actorId: fixtures.reviewerId,
          actingRoleId: fixtures.reviewerRoleId,
          actionId: uuid(),
          requestId: 'synthetic-compiler-worker-wrong-action',
        });
        await tx.query(
          `insert into content.compilation_run
             (id, basis_id, compiler_digest, dependency_digest, run_status, draft_only,
              semantic_digest, hir_provenance, cir_provenance, diagnostics,
              conversion_loss, run_digest,
              requested_by_action, recorded_by)
           values ($1,$2,$3,$4,'succeeded',false,$5,
                   jsonb_build_array(jsonb_build_object(
                     'nodeId','hir:test','sourceKind','fragment','sourceId',$9::text,
                     'sourcePath',null,'sourceDigest',$10::text
                   )),
                   jsonb_build_array(jsonb_build_object(
                     'nodeId','cir:test','sourceKind','fragment','sourceId',$9::text,
                     'sourcePath',null,'sourceDigest',$10::text
                   )),
                   '[]','[]',$6,$7,$8)`,
          [
            uuid(),
            basisId,
            compilerDigest,
            dependencyDigest,
            semanticDigest,
            hexDigest('e'),
            requested.actionId,
            fixtures.reviewerId,
            fragmentRevision2Id,
            fragmentRevisionDigest,
          ],
        );
      }),
    ).rejects.toThrow(/active transaction action/i);
    await withTransaction(harness.adminPool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      await setTransactionContext(tx, {
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        actionId: requested.actionId,
        requestId: 'synthetic-compiler-worker',
      });
      await tx.query(
        `insert into content.compilation_run
           (id, basis_id, compiler_digest, dependency_digest, run_status, draft_only,
            semantic_digest, hir_provenance, cir_provenance, diagnostics,
            conversion_loss, run_digest,
            requested_by_action, recorded_by)
         values ($1,$2,$3,$4,'succeeded',false,$5,
                 jsonb_build_array(jsonb_build_object(
                   'nodeId','hir:test','sourceKind','fragment','sourceId',$9::text,
                   'sourcePath',null,'sourceDigest',$10::text
                 )),
                 jsonb_build_array(jsonb_build_object(
                   'nodeId','cir:test','sourceKind','fragment','sourceId',$9::text,
                   'sourcePath',null,'sourceDigest',$10::text
                 )),
                 '[]','[]',$6,$7,$8)`,
        [
          runId,
          basisId,
          compilerDigest,
          dependencyDigest,
          semanticDigest,
          runDigest,
          requested.actionId,
          fixtures.reviewerId,
          fragmentRevision2Id,
          fragmentRevisionDigest,
        ],
      );
      await tx.query(
        `insert into content.compiled_view
           (id, compilation_run_id, target, media_type, artifact_version_id,
            content_digest, recorded_by)
         values ($1,$2,'html','text/html',$3,$4,$5)`,
        [viewId, runId, artifactVersionId, viewDigest, fixtures.reviewerId],
      );
      await tx.query(
        `insert into content.compilation_run_preimage
           (run_id, semantic_graph, semantic_preimage, canonical_preimage, recorded_by)
         values ($1,$2,$3,$4,$5)`,
        [
          runId,
          JSON.stringify(semanticGraph),
          canonicalize(semanticGraph),
          canonicalRunPreimage,
          fixtures.reviewerId,
        ],
      );
    });

    const accepted = await call('accept_document_compilation', [compositionId], {
      document_policy: 'ordinary',
      run_id: runId,
      run_digest: runDigest,
    });
    const unsafePublicationTargetId = uuid();
    const publicationTargetId = uuid();
    const racingPublicationTargetId = uuid();
    const revokedCompilerPublicationTargetId = uuid();
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        `insert into content.document_publication_target
           (id, organization_id, target_key, max_classification, policy_digest, registered_by)
         values ($1,$2,'public-test-site','public',$3,$4),
                ($5,$2,'internal-test-site','internal',$6,$4),
                ($7,$2,'retirement-race-site','internal',$8,$4),
                ($9,$2,'revoked-compiler-site','internal',$10,$4)`,
        [
          unsafePublicationTargetId,
          fixtures.organizationId,
          hexDigest('1'),
          fixtures.reviewerId,
          publicationTargetId,
          hexDigest('2'),
          racingPublicationTargetId,
          hexDigest('3'),
          revokedCompilerPublicationTargetId,
          hexDigest('4'),
        ],
      );
    });

    const controlledDocument = await call('add_controlled_document', [], {
      title: 'Controlled Document Constitution HTML',
      document_class: 'specification',
      document_number: 'OH-DOC-TEST-001',
      revision: 'R01',
      owning_role: 'technical_authority',
      content_version: artifactVersionId,
    });
    const controlledDocumentId = controlledDocument.objectIds[0]!;
    const publicationPayload = {
      document_policy: 'ordinary',
      compiled_view_id: viewId,
      compiled_view_digest: viewDigest,
      acceptance_action_id: accepted.actionId,
      controlled_document_id: controlledDocumentId,
      controlled_content_version_id: artifactVersionId,
    };

    await expect(
      call('publish_document_view', [compositionId], {
        ...publicationPayload,
        publication_target_id: unsafePublicationTargetId,
      }),
    ).rejects.toThrow();

    await expect(
      call('publish_document_view', [compositionId], {
        ...publicationPayload,
        publication_target_id: publicationTargetId,
      }),
    ).rejects.toMatchObject({ detail: { rule: 'KF-DOC-PUBLISH-005' } });

    await call('submit_document_for_review', [controlledDocumentId], {});
    await call('approve_controlled_document', [controlledDocumentId], { to_state: 'approved' });
    await call('make_document_effective', [controlledDocumentId], {});

    const mismatchedDigestActionId = uuid();
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        await setTransactionContext(tx, {
          actorId: fixtures.reviewerId,
          actingRoleId: fixtures.reviewerRoleId,
          actionId: mismatchedDigestActionId,
          requestId: `publication-digest-mismatch-${mismatchedDigestActionId}`,
        });
        await tx.query(
          `insert into core.action
             (id, action_type, actor_id, acting_role_id, target_ids, parameters,
              preconditions, idempotency_key, effective_at, request_id, result_status, result,
              organization_id, request_digest)
           values ($1,'publish_document_view',$2,$3,$4,$5,'{}',$6,date_trunc('milliseconds', now()),$7,'applied','{}',$8,$9)`,
          [
            mismatchedDigestActionId,
            fixtures.reviewerId,
            fixtures.reviewerRoleId,
            [compositionId],
            JSON.stringify({
              compiled_view_id: viewId,
              compiled_view_digest: hexDigest('f'),
              acceptance_action_id: accepted.actionId,
              controlled_document_id: controlledDocumentId,
              controlled_content_version_id: artifactVersionId,
              publication_target_id: publicationTargetId,
            }),
            `publish-mismatch-${mismatchedDigestActionId}`,
            `publication-digest-mismatch-${mismatchedDigestActionId}`,
            fixtures.organizationId,
            hexDigest('8'),
          ],
        );
        await tx.query(
          `insert into content.document_publication
             (action_id, acceptance_action_id, organization_id, subject_id, compiled_view_id,
              compiled_view_digest, controlled_document_id, controlled_content_version_id,
              publication_target_id, publication_target_policy_digest,
              effective_classification, published_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'internal',$11)`,
          [
            mismatchedDigestActionId,
            accepted.actionId,
            fixtures.organizationId,
            compositionId,
            viewId,
            viewDigest,
            controlledDocumentId,
            artifactVersionId,
            publicationTargetId,
            hexDigest('2'),
            fixtures.reviewerId,
          ],
        );
      }),
    ).rejects.toThrow(/recorded action parameters/i);

    const racingPublicationActionId = uuid();
    const publicationClient = await harness.adminPool.connect();
    const retirementClient = await harness.adminPool.connect();
    try {
      await publicationClient.query('begin');
      await publicationClient.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      await publicationClient.query('select core.set_transaction_context($1, $2, $3, $4)', [
        fixtures.reviewerId,
        fixtures.reviewerRoleId,
        racingPublicationActionId,
        `publication-retirement-race-${racingPublicationActionId}`,
      ]);
      await publicationClient.query(
        `insert into core.action
           (id, action_type, actor_id, acting_role_id, target_ids, parameters,
            preconditions, idempotency_key, effective_at, request_id, result_status, result,
            organization_id, request_digest)
         values ($1,'publish_document_view',$2,$3,$4,$5,'{}',$6,date_trunc('milliseconds', now()),$7,'applied','{}',$8,$9)`,
        [
          racingPublicationActionId,
          fixtures.reviewerId,
          fixtures.reviewerRoleId,
          [compositionId],
          JSON.stringify({
            compiled_view_id: viewId,
            compiled_view_digest: viewDigest,
            acceptance_action_id: accepted.actionId,
            controlled_document_id: controlledDocumentId,
            controlled_content_version_id: artifactVersionId,
            publication_target_id: racingPublicationTargetId,
          }),
          `publish-race-${racingPublicationActionId}`,
          `publication-retirement-race-${racingPublicationActionId}`,
          fixtures.organizationId,
          hexDigest('9'),
        ],
      );

      await retirementClient.query('begin');
      await retirementClient.query('select core.set_access_context($1, $2)', [
        fixtures.organizationId,
        'restricted',
      ]);
      await retirementClient.query('select core.set_transaction_context($1, $1, $2, $3)', [
        fixtures.reviewerId,
        uuid(),
        'publication-target-retirement-race',
      ]);
      await retirementClient.query(
        `insert into content.document_publication_target_retirement
           (target_id, retired_by, retirement_reason)
         values ($1,$2,'race-test retirement')`,
        [racingPublicationTargetId, fixtures.reviewerId],
      );

      const publicationRejection = expect(
        publicationClient.query(
          `insert into content.document_publication
             (action_id, acceptance_action_id, organization_id, subject_id, compiled_view_id,
              compiled_view_digest, controlled_document_id, controlled_content_version_id,
              publication_target_id, publication_target_policy_digest,
              effective_classification, published_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'internal',$11)`,
          [
            racingPublicationActionId,
            accepted.actionId,
            fixtures.organizationId,
            compositionId,
            viewId,
            viewDigest,
            controlledDocumentId,
            artifactVersionId,
            racingPublicationTargetId,
            hexDigest('3'),
            fixtures.reviewerId,
          ],
        ),
      ).rejects.toThrow(/destination is unavailable/i);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await retirementClient.query('commit');
      await publicationRejection;
    } finally {
      await publicationClient.query('rollback').catch(() => undefined);
      await retirementClient.query('rollback').catch(() => undefined);
      publicationClient.release();
      retirementClient.release();
    }

    await expect(
      call('publish_document_view', [compositionId], {
        ...publicationPayload,
        controlled_content_version_id: uuid(),
        publication_target_id: publicationTargetId,
      }),
    ).rejects.toMatchObject({ detail: { rule: 'KF-DOC-PUBLISH-005' } });

    await call('publish_document_view', [compositionId], {
      ...publicationPayload,
      publication_target_id: publicationTargetId,
    });

    // Migration 007 must re-audit historical runs at acceptance. Simulate a pre-007
    // partial-provenance row by extending its immutable Basis behind legacy trigger bypass:
    // arrays remain non-empty, but neither HIR nor CIR covers the newly exposed input.
    await withTransaction(harness.adminPool, async (tx) => {
      await tx.query('set local session_replication_role = replica');
      await tx.query(
        `insert into content.compilation_basis_fragment (basis_id, fragment_revision_id)
         values ($1,$2)`,
        [basisId, fragmentRevision1Id],
      );
    });
    try {
      await expect(
        call('accept_document_compilation', [compositionId], {
          document_policy: 'ordinary',
          run_id: runId,
          run_digest: runDigest,
        }),
      ).rejects.toMatchObject({ detail: { rule: 'KF-DOC-COMPILE-004' } });
    } finally {
      await withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local session_replication_role = replica');
        await tx.query(
          `delete from content.compilation_basis_fragment
            where basis_id = $1 and fragment_revision_id = $2`,
          [basisId, fragmentRevision1Id],
        );
      });
    }

    // Revocation and every enabled check share one transaction advisory lock. Hold the
    // revocation open, prove acceptance cannot settle, then commit and require fail-closed.
    const revocationClient = await harness.adminPool.connect();
    let revocationCommitted = false;
    try {
      await revocationClient.query('begin');
      await revocationClient.query(
        `insert into content.document_compiler_revocation
           (registration_id, revoked_by, revocation_reason)
         values ($1,$2,'Synthetic revocation racing repeated acceptance')`,
        [compilerRegistrationId, fixtures.reviewerId],
      );

      let racingAcceptanceSettled = false;
      const racingAcceptance = call('accept_document_compilation', [compositionId], {
        document_policy: 'ordinary',
        run_id: runId,
        run_digest: runDigest,
      }).then(
        (value) => {
          racingAcceptanceSettled = true;
          return { status: 'fulfilled' as const, value };
        },
        (error: unknown) => {
          racingAcceptanceSettled = true;
          return { status: 'rejected' as const, error };
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(racingAcceptanceSettled).toBe(false);

      await revocationClient.query('commit');
      revocationCommitted = true;
      const outcome = await racingAcceptance;
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.error).toMatchObject({ detail: { rule: 'KF-DOC-COMPILE-004' } });
      }
    } finally {
      if (!revocationCommitted) {
        await revocationClient.query('rollback').catch(() => undefined);
      }
      revocationClient.release();
    }

    const revokedCompilerPublicationActionId = uuid();
    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await setAccessContext(tx, {
          organizationId: fixtures.organizationId,
          maxClassification: 'restricted',
        });
        await setTransactionContext(tx, {
          actorId: fixtures.reviewerId,
          actingRoleId: fixtures.reviewerRoleId,
          actionId: revokedCompilerPublicationActionId,
          requestId: `revoked-compiler-publication-${revokedCompilerPublicationActionId}`,
        });
        await tx.query(
          `insert into core.action
             (id, action_type, actor_id, acting_role_id, target_ids, parameters,
              preconditions, idempotency_key, effective_at, request_id, result_status, result,
              organization_id, request_digest)
           values ($1,'publish_document_view',$2,$3,$4,$5,'{}',$6,date_trunc('milliseconds', now()),$7,'applied','{}',$8,$9)`,
          [
            revokedCompilerPublicationActionId,
            fixtures.reviewerId,
            fixtures.reviewerRoleId,
            [compositionId],
            JSON.stringify({
              compiled_view_id: viewId,
              compiled_view_digest: viewDigest,
              acceptance_action_id: accepted.actionId,
              controlled_document_id: controlledDocumentId,
              controlled_content_version_id: artifactVersionId,
              publication_target_id: revokedCompilerPublicationTargetId,
            }),
            `revoked-compiler-publication-${revokedCompilerPublicationActionId}`,
            `revoked-compiler-publication-${revokedCompilerPublicationActionId}`,
            fixtures.organizationId,
            hexDigest('a'),
          ],
        );
        await tx.query(
          `insert into content.document_publication
             (action_id, acceptance_action_id, organization_id, subject_id, compiled_view_id,
              compiled_view_digest, controlled_document_id, controlled_content_version_id,
              publication_target_id, publication_target_policy_digest,
              effective_classification, published_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'internal',$11)`,
          [
            revokedCompilerPublicationActionId,
            accepted.actionId,
            fixtures.organizationId,
            compositionId,
            viewId,
            viewDigest,
            controlledDocumentId,
            artifactVersionId,
            revokedCompilerPublicationTargetId,
            hexDigest('4'),
            fixtures.reviewerId,
          ],
        );
      }),
    ).rejects.toThrow(/enabled compiler/i);

    const proposalId = uuid();
    const proposalHolderId = uuid();
    const provenance = modelProvenance(
      basisId,
      fragmentId,
      fragmentRevision2Id,
      fragmentRevisionDigest,
    );
    await expect(
      call(
        'record_document_proposal',
        [fragmentId],
        {
          proposal_id: uuid(),
          basis_id: basisId,
          proposal_kind: 'source_patch',
          proposed_by_kind: 'model',
          model_provider: 'local-test',
          model_profile: 'deterministic-fixture',
          model_request_id: 'request-test-only',
          base_fragment_revision_id: fragmentRevision2Id,
          operations: [
            {
              operation: 'replace_fragment_source',
              media_type: 'text/markdown',
              classification: 'internal',
              holder_id: uuid(),
              previous_holder_id: fragmentRevisionHolderId,
              holder: {
                kind: 'git',
                repository: 'local/openhuman',
                commit_sha: commit('0'),
                path: 'docs/atoms/purpose.md',
                submodule_commit_sha: null,
                content_digest: hexDigest('0'),
              },
            },
          ],
        },
        'author',
      ),
    ).rejects.toMatchObject({ detail: { rule: 'KF-DOC-PROPOSAL-014' } });
    await call(
      'record_document_proposal',
      [fragmentId],
      {
        proposal_id: proposalId,
        basis_id: basisId,
        proposal_kind: 'source_patch',
        proposed_by_kind: 'model',
        model_provider: 'local-test',
        model_profile: 'deterministic-fixture',
        model_request_id: 'request-test-only',
        model_provenance: provenance,
        base_fragment_revision_id: fragmentRevision2Id,
        operations: [
          {
            operation: 'replace_fragment_source',
            media_type: 'text/markdown',
            classification: 'internal',
            holder_id: proposalHolderId,
            previous_holder_id: fragmentRevisionHolderId,
            holder: {
              kind: 'git',
              repository: 'local/openhuman',
              commit_sha: commit('0'),
              path: 'docs/atoms/purpose.md',
              submodule_commit_sha: null,
              content_digest: hexDigest('0'),
            },
          },
        ],
      },
      'author',
    );
    const proposalDigest = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return await tx.one<{ proposal_digest: string; model_provenance: unknown }>(
        'select proposal_digest, model_provenance from content.proposal_overlay where id = $1',
        [proposalId],
      );
    });
    expect(proposalDigest.model_provenance).toEqual(provenance);
    const fragmentRevision3Id = uuid();
    await call('apply_document_proposal', [fragmentId], {
      proposal_id: proposalId,
      proposal_digest: proposalDigest.proposal_digest,
      revision_id: fragmentRevision3Id,
    });

    const appliedProposalState = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return (
        await tx.one<{ revision_state: string }>(
          'select revision_state from content.authored_fragment_revision where id = $1',
          [fragmentRevision3Id],
        )
      ).revision_state;
    });
    expect(appliedProposalState).toBe('draft');

    // Draft source remains live: a typed revise/retire action can move it, while publication
    // still requires a separately reviewed and effective Controlled Document Revision.
    const retiredFragmentRevisionId = uuid();
    await call(
      'retire_authored_fragment',
      [fragmentId],
      {
        revision_id: retiredFragmentRevisionId,
        previous_revision_id: fragmentRevision3Id,
        media_type: 'text/markdown',
        classification: 'internal',
        quality_role_assignment_id: qualityRoleAssignmentId,
      },
      'technical',
    );

    await expect(
      withTransaction(harness.adminPool, async (tx) =>
        tx.query('select content.assert_fragment_revisions_active($1::uuid[])', [
          [fragmentRevision3Id],
        ]),
      ),
    ).rejects.toThrow(/retired authored fragment/);

    await expect(
      call(
        'add_document_composition',
        [],
        {
          title: 'Must not revive retired source',
          stable_key: 'retired-source-revival-attempt',
          holder_id: uuid(),
          holder: {
            kind: 'git',
            repository: 'local/openhuman',
            commit_sha: commit('c'),
            path: 'docs/compose-retired.toml',
            submodule_commit_sha: null,
            content_digest: hexDigest('3'),
          },
          revision_id: uuid(),
          classification: 'internal',
          document_policy: 'ordinary',
          inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: fragmentRevision3Id }],
        },
        'author',
      ),
    ).rejects.toMatchObject({ detail: { rule: 'KF-DOC-COMP-004' } });

    const facts = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return tx.one<{
        fragment_state: string;
        fragment_revisions: string;
        composition_revisions: string;
        fragment_holders: string;
        composition_holders: string;
        requests: string;
        proposals: string;
        proposal_revision_state: string;
        publications: string;
      }>(
        `select
           (select lifecycle_state from core.object where id = $1) as fragment_state,
           (select count(*)::text from content.authored_fragment_revision where fragment_id = $1)
             as fragment_revisions,
           (select count(*)::text from content.composition_revision where composition_id = $2)
             as composition_revisions,
           (select count(*)::text from content.document_source_holder where subject_id = $1)
             as fragment_holders,
           (select count(*)::text from content.document_source_holder where subject_id = $2)
             as composition_holders,
           (select count(*)::text from content.compilation_basis where created_by_action = $3)
             as requests,
           (select count(*)::text from content.proposal_overlay where id = $4) as proposals,
           (select revision_state from content.authored_fragment_revision where id = $5)
             as proposal_revision_state,
           (select count(*)::text from content.document_publication
             where subject_id = $2 and compiled_view_id = $6) as publications`,
        [fragmentId, compositionId, requested.actionId, proposalId, fragmentRevision3Id, viewId],
      );
    });
    expect(facts).toEqual({
      fragment_state: 'retired',
      fragment_revisions: '4',
      composition_revisions: '2',
      fragment_holders: '4',
      composition_holders: '2',
      requests: '1',
      proposals: '1',
      proposal_revision_state: 'draft',
      publications: '1',
    });
  }, 180_000);
});
