import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { readVersionBytes, StoreRegistry, verifyRecordedVersion } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  createExport,
  readWarrantRuntimeEvidence,
  importExport,
  signExportPackage,
  PRESERVATION_IMPORT_TARGETS,
} from '@kf/export';
import { bindContext, createObject, seedFixtures, startHarness, type Harness } from './harness.js';
import { PreservationMinio } from './preservation-minio.js';

// Shared scope: OpenWarrant OW-WAR-0111. These are disposable fixture identities,
// never signatures or assurance claims over an actual project Warrant.
it('preserves Warrant revisions, standing and action history after source shutdown', async () => {
  const source = await startHarness();
  const storage = new PreservationMinio();
  let sourceStopped = false;
  let restored: Harness | undefined;
  try {
    restored = await startHarness();
    const fixtures = await seedFixtures(source.adminPool);
    const dispatch = createFabricDispatcher(source.pool);
    const archiveBytes = await readFile(
      new URL(
        '../fixtures/openwarrant-preservation/kf-source-complete-archive.json',
        import.meta.url,
      ),
    );
    const identity: {
      archive_sha256: string;
      subject: string;
      canonical_ir: {
        identity: { uuid: string; local_alias: string };
        integrity: { composition_revision_digest: string; workspace_basis_digest: string };
      } & NonNullable<Parameters<typeof dispatch>[0]['payload']>;
    } = JSON.parse(
      await readFile(
        new URL(
          '../fixtures/openwarrant-preservation/kf-source-complete-identity.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(createHash('sha256').update(archiveBytes).digest('hex')).toBe(identity.archive_sha256);
    const sourceArchive = JSON.parse(archiveBytes.toString('utf8')) as {
      schema: string;
      coverage: Record<string, { state: string }>;
    };
    expect(sourceArchive.schema).toBe('oh.war/preservation-archive/v1-draft.1');
    expect(Object.keys(sourceArchive.coverage)).toHaveLength(14);
    expect(
      Object.values(sourceArchive.coverage).every(
        (entry) => entry.state === 'retained' || entry.state === 'absent',
      ),
    ).toBe(true);

    expect(identity.subject).toBe(`war://${identity.canonical_ir.identity.uuid}`);
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const act = async (
      actionType: string,
      targetIds: string[],
      payload: NonNullable<Parameters<typeof dispatch>[0]['payload']>,
    ) => {
      const result = await dispatch({
        actionType,
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: randomUUID(),
        reason: 'OW111 disposable preservation fixture',
        targetIds,
        payload,
      });
      expect(result.status).toBe('applied');
      return result;
    };
    const draft = async (alias: string, sourceUuid?: string) => {
      const { id } = await withTransaction(source.adminPool, (tx) =>
        tx.one<{ id: string }>('select coalesce($1::uuid, uuidv7())::text as id', [
          sourceUuid ?? null,
        ]),
      );
      await act('create_warrant_draft', [], {
        warrant_uuid: id,
        repository: 'ow111-disposable-fixture',
        local_alias: alias,
        title: alias,
        profile: 'delivery',
        assurance_level: 'controlled',
      });
      return id;
    };
    const resolve = async (id: string) => {
      await act('submit_warrant', [id], {
        contract_digest:
          id === identity.canonical_ir.identity.uuid
            ? identity.canonical_ir.integrity.composition_revision_digest
            : sha(id),
        compilation_basis:
          id === identity.canonical_ir.identity.uuid
            ? identity.canonical_ir.integrity.workspace_basis_digest
            : sha(`basis-${id}`),
        canonical_ir:
          id === identity.canonical_ir.identity.uuid
            ? identity.canonical_ir
            : { schema: 'oh.war/ir/v1', intent: { problem: id } },
      });
      await act('authorize_warrant_contract', [id], {
        contract_digest:
          id === identity.canonical_ir.identity.uuid
            ? identity.canonical_ir.integrity.composition_revision_digest
            : sha(id),
        authorization_meaning: 'fixture authorization only',
        policy_basis: 'disposable OW111 test',
      });
      await act('record_warrant_preflight', [id], {
        receipt_digest: sha(`preflight-${id}`),
        outcomes: { 'fixture.ready': 'passed' },
        readiness: 'ready',
        performed_at: new Date().toISOString(),
      });
      await act('authorize_warrant_dispatch', [id], {
        dispatch_digest: sha(`dispatch-${id}`),
        performer_ref: 'fixture://ow111',
      });
      await act('attach_warrant_runtime_receipt', [id], {
        adapter: 'oh.war/katana-receipt/v1',
        dispatch_digest: sha(`dispatch-${id}`),
        receipt_digest: sha(`runtime-${id}`),
        terminal_status: 'completed',
        artifact_refs: [],
        receipt: {
          session_id: id,
          dispatch_digest: sha(`dispatch-${id}`),
          prompt_ir_digest: sha(`fixture-prompt-${id}`),
          provider_model_identity: 'fixture://no-model-called',
          runtime_event_log_head: sha(`fixture-events-${id}`),
          realized_capabilities: ['fixture.record-retention'],
          confinement: 'disposable test containers',
          usage: 'synthetic receipt fixture; no model spend',
          artifact_refs: [],
          terminal_runtime_status: 'completed',
          receipt_digest: sha(`runtime-${id}`),
          taint_label_refs: [],
        },
      });
      await act('open_warrant_blocker', [id], {
        blocker_ref: 'B-1',
        condition_ref: 'PRE-001',
        reason: 'fixture dependency',
        owner_ref: 'fixture://owner',
        required_to_unblock: 'fixture recovery',
      });
      await act('resolve_warrant_blocker', [id], {
        blocker_ref: 'B-1',
        resolution: 'fixture recovered',
      });
      await act('register_warrant_submission', [id], {
        submission_ref: 'S-1',
        artifact_refs: [],
        blocker_refs: [],
        deviation_refs: [],
        requested_next_action: 'verify',
      });
      await act('propose_warrant_deviation', [id], {
        deviation_ref: 'D-1',
        affected_contract_path: '/execution/fixture',
        proposed_change: { fixture: 'isolated' },
        reason: 'fixture variation',
        impact: { production: 'none' },
      });
      await act('approve_warrant_deviation', [id], {
        deviation_ref: 'D-1',
        decision_reason: 'fixture only',
      });
      await act('record_warrant_discovered_gap', [id], {
        gap_ref: 'G-1',
        statement: 'fixture missing condition',
        under_specified: 'gate',
        disposition: 'amendment',
      });
      await act('register_warrant_evidence', [id], {
        evidence_ref: 'E-1',
        kind: 'external_tool_verdict',
        origin: 'knowledge_fabric',
        admissibility: 'authoritative_external',
        content_digest: sha(`evidence-${id}`),
        collection_method: 'disposable fixture',
        occurred_at: '2026-09-18T00:00:00Z',
      });
      await act('attach_warrant_gate_run', [id], {
        gate_run_ref: 'GR-1',
        gate_ref: 'gate://fixture/ow111@1.0.0',
        definition_digest: sha('fixture gate'),
        binding_digest: sha(id),
        execution_status: 'completed',
        verdict: 'pass',
        receipt_digest: sha(`gate-${id}`),
        receipt: { fixture: true, production_claim: false },
      });
      await act('record_warrant_inference', [id], {
        inference_ref: 'I-1',
        kind: 'deductive',
        statement: 'fixture inference',
        premise_refs: ['E-1', 'GR-1'],
        claim_ref: 'OBL-FIXTURE',
      });
      await act('record_warrant_judgment', [id], {
        judgment_ref: 'J-1',
        kind: 'acceptance',
        statement: 'fixture judgment',
        meaning: 'disposable records only',
        basis_refs: ['I-1'],
        authority: 'technical_authority',
        limitations: ['No real project acceptance'],
      });
      await act('request_warrant_resolution', [id], {
        requested_outcome: 'satisfied',
        basis_refs: ['J-1'],
      });
      await act('resolve_warrant', [id], { outcome: 'satisfied' });
    };
    const superseded = await draft(
      identity.canonical_ir.identity.local_alias,
      identity.canonical_ir.identity.uuid,
    );
    const successor = await draft('OW-WAR-9902');
    const disputed = await draft('OW-WAR-9903');
    const annulled = await draft('OW-WAR-9904');
    for (const id of [superseded, disputed, annulled]) await resolve(id);
    await act('supersede_warrant', [superseded], { superseded_by: successor });
    await act('dispute_warrant_resolution', [disputed], { dispute: 'fixture unresolved dispute' });
    await act('dispute_warrant_resolution', [annulled], { dispute: 'fixture upheld dispute' });
    await act('annul_warrant_resolution', [annulled], { annulment_basis: 'fixture withdrawal' });

    const objectSource = await storage.start();
    const bytes = archiveBytes;
    const artifactId = await createObject(source.adminPool, fixtures, {
      type: 'artifact',
      domain: 'content',
      state: 'draft',
      title: 'OW111 binary evidence',
      createdBy: fixtures.reviewerId,
    });
    const key = `artifacts/${artifactId}/v1`;
    const stored = await objectSource.store.put(key, bytes, 'application/octet-stream');
    expect(stored.versionId).toBeTruthy();
    const versionId = randomUUID();
    const contentDigest = createHash('sha256').update(bytes).digest('hex');
    await withTransaction(source.adminPool, async (tx) => {
      await bindContext(tx, fixtures, fixtures.reviewerId);
      await tx.query(
        `insert into content.artifact (id, artifact_kind, source_system)
        values ($1, 'document', 'object_store')`,
        [artifactId],
      );
      await tx.query(
        `insert into content.artifact_version
        (id, artifact_id, version_no, sha256, size_bytes, media_type, storage_uri,
         storage_version, created_by, created_by_action)
        values ($1,$2,1,$3,$4,'application/octet-stream',$5,$6,$7,$8)`,
        [
          versionId,
          artifactId,
          contentDigest,
          bytes.length,
          key,
          stored.versionId,
          fixtures.reviewerId,
          fixtures.clearanceActionId,
        ],
      );
    });
    await act('register_warrant_artifact', [superseded], {
      artifact_ref: artifactId,
      artifact_version_id: versionId,
      producer_ref: 'fixture://ow111',
      producing_attempt: 'preservation-1',
      contract_digest: identity.canonical_ir.integrity.composition_revision_digest,
      input_digests: [contentDigest],
      tool_identity: 'OW111 real MinIO fixture',
      creation_method: 'generated',
      content_digest: contentDigest,
      media_type: 'application/octet-stream',
      classification: 'internal',
      retention_class: 'project_record',
      source_holder: 'fabric_native',
    });

    const keys = generateKeyPairSync('ed25519');
    const keyId = 'ow111-disposable-export-key';
    const first = signExportPackage(
      await withTransaction(source.adminPool, (tx) => createExport(tx)),
      { keyId, privateKey: keys.privateKey },
    );
    const warrantSections = Object.entries(PRESERVATION_IMPORT_TARGETS).filter(([name]) =>
      name.startsWith('warrant'),
    );
    // A symmetric exporter omission can survive an exact round trip. Compare its
    // field inventory with the live migrated database before shutting source down.
    await withTransaction(source.adminPool, async (tx) => {
      for (const [section, qualifiedTable] of warrantSections) {
        const [schema, table] = qualifiedTable.split('.');
        const columns = await tx.query<{ column_name: string }>(
          `select column_name from information_schema.columns
           where table_schema = $1 and table_name = $2 and is_generated = 'NEVER'
           order by column_name`,
          [schema, table],
        );
        const file = first.files.find((entry) => entry.path === `${section}.json`);
        if (file === undefined) throw new Error(`missing ${section}`);
        const rows: Record<string, unknown>[] = JSON.parse(file.content);
        expect(rows.length, section).toBeGreaterThan(0);
        for (const row of rows) {
          expect(Object.keys(row).sort(), `${section} dropped a column`).toEqual(
            columns.map((column) => column.column_name),
          );
        }
      }
    });
    for (const [section] of warrantSections) {
      expect(first.manifest.counts[section], `${section} must be populated`).toBeGreaterThan(0);
    }
    expect(first.manifest.counts['warrants']).toBe(4);
    expect(first.manifest.counts['warrant-contract-revisions']).toBe(6);
    expect(first.manifest.counts['actions']).toBeGreaterThan(20);
    expect(first.manifest.counts['audit-events']).toBeGreaterThan(20);
    await source.stop();
    sourceStopped = true;
    const trust = new Map([[keyId, keys.publicKey]]);
    expect(() => readWarrantRuntimeEvidence(first, superseded, new Map())).toThrow(/untrusted_key/);
    expect(() => readWarrantRuntimeEvidence(first, randomUUID(), trust)).toThrow(
      /matching Warrant/,
    );
    const runtimeEvidence = readWarrantRuntimeEvidence(first, superseded, trust);
    expect(runtimeEvidence.contracts).toHaveLength(2);
    expect(runtimeEvidence.dispatches).toHaveLength(1);
    expect(runtimeEvidence.receipts).toHaveLength(1);
    expect(runtimeEvidence.receipts[0]?.['receipt']).toMatchObject({
      $kf_type: 'postgres.jsonb',
      text: expect.stringContaining('fixture://no-model-called'),
    });
    const missingRuntime = {
      ...first,
      files: first.files.filter((file) => file.path !== 'warrant-runtime-receipts.json'),
    };
    expect(() => readWarrantRuntimeEvidence(missingRuntime, superseded, trust)).toThrow(/missing/);
    const objectRestored = await storage.restore(objectSource.id);

    // Untrusted origins refuse before any Warrant becomes visible in the target.
    await expect(
      withTransaction(restored.adminPool, (tx) => importExport(tx, first)),
    ).rejects.toThrow(/untrusted_key/);
    for (const [section] of warrantSections) {
      const omitted = {
        ...first,
        files: first.files.filter((file) => file.path !== `${section}.json`),
      };
      await expect(
        withTransaction(restored.adminPool, (tx) =>
          importExport(tx, omitted, { trustedManifestKeys: new Map([[keyId, keys.publicKey]]) }),
        ),
        section,
      ).rejects.toThrow(/missing/);
    }
    const empty = await withTransaction(restored.adminPool, (tx) =>
      tx.one<{ count: string }>('select count(*)::text as count from work.warrant'),
    );
    expect(empty.count).toBe('0');
    await withTransaction(restored.adminPool, (tx) =>
      importExport(tx, first, { trustedManifestKeys: new Map([[keyId, keys.publicKey]]) }),
    );
    const registry = new StoreRegistry({ working: objectRestored.store });
    const reconnected = await withTransaction(restored.adminPool, (tx) =>
      readVersionBytes(tx, registry, versionId),
    );
    expect(reconnected?.bytes).toEqual(bytes);
    expect(reconnected?.servedFrom.store_version).toBe(stored.versionId);
    // Optional durable output lets the producer reconstruct IR from the recovered object.
    // This does not skip or weaken the ordinary CI assertions.
    const restoredArchivePath = process.env['OW111_RESTORED_ARCHIVE'];
    if (restoredArchivePath !== undefined) {
      if (reconnected === undefined) throw new Error('no restored source archive');
      await writeFile(restoredArchivePath, reconnected.bytes, { flag: 'wx', mode: 0o600 });
    }
    const restoredSource = await withTransaction(restored.adminPool, (tx) =>
      tx.query<{ canonical_ir: unknown; contract_digest: string; compilation_basis: string }>(
        'select canonical_ir, contract_digest, compilation_basis from work.warrant_contract_revision where warrant_id = $1 order by revision_no',
        [superseded],
      ),
    );
    expect(restoredSource).toHaveLength(2);
    for (const revision of restoredSource) {
      expect(revision.canonical_ir).toEqual(identity.canonical_ir);
      expect(revision.contract_digest).toBe(
        identity.canonical_ir.integrity.composition_revision_digest,
      );
      expect(revision.compilation_basis).toBe(
        identity.canonical_ir.integrity.workspace_basis_digest,
      );
    }
    const version = {
      sha256: contentDigest,
      sizeBytes: bytes.length,
      storageUri: key,
      storageVersion: stored.versionId ?? null,
    };
    await expect(verifyRecordedVersion(objectRestored.store, version)).resolves.toEqual({
      ok: true,
    });
    await expect(
      verifyRecordedVersion(objectRestored.store, { ...version, sha256: sha('wrong bytes') }),
    ).resolves.toMatchObject({ ok: false, failure: 'digest_mismatch' });
    // A new value at the same key cannot replace the immutable referenced version.
    await objectRestored.store.put(key, Buffer.from('replacement'), 'application/octet-stream');
    await expect(verifyRecordedVersion(objectRestored.store, version)).resolves.toEqual({
      ok: true,
    });
    await storage.client(
      objectRestored.id,
      'rm',
      '--version-id',
      stored.versionId ?? '',
      `fixture/preserved/${key}`,
    );
    await expect(verifyRecordedVersion(objectRestored.store, version)).resolves.toMatchObject({
      ok: false,
      failure: 'not_uploaded',
    });
    const missing = await withTransaction(restored.adminPool, (tx) =>
      readVersionBytes(tx, registry, versionId),
    );
    expect(missing).toBeUndefined();

    const second = await withTransaction(restored.adminPool, (tx) => createExport(tx));
    expect(second.manifest.database_snapshot_sha256).toBe(first.manifest.database_snapshot_sha256);
    for (const file of second.files) {
      expect(
        first.files.find((candidate) => candidate.path === file.path)?.content,
        file.path,
      ).toBe(file.content);
    }
    expect(second.manifest.files).toEqual(first.manifest.files);
    const states = await withTransaction(restored.adminPool, (tx) =>
      tx.query<{
        id: string;
        currency: string;
        standing: string;
        outcome: string;
        superseded_by: string | null;
      }>('select id, currency, standing, outcome, superseded_by from work.warrant order by id'),
    );
    expect(states.find((row) => row.id === superseded)).toMatchObject({
      currency: 'superseded',
      superseded_by: successor,
      outcome: 'satisfied',
    });
    expect(states.find((row) => row.id === disputed)).toMatchObject({
      standing: 'disputed',
      outcome: 'satisfied',
    });
    expect(states.find((row) => row.id === annulled)).toMatchObject({
      standing: 'annulled',
      outcome: 'satisfied',
    });
  } finally {
    try {
      if (!sourceStopped) await source.stop();
    } finally {
      try {
        await restored?.stop();
      } finally {
        await storage.stop();
      }
    }
  }
}, 240_000);
