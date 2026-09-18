import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import { createExport, importExport, signExportPackage } from '@kf/export';
import { seedFixtures, startHarness, type Harness } from './harness.js';

// Shared scope: OpenWarrant OW-WAR-0111. These are disposable fixture identities,
// never signatures or assurance claims over an actual project Warrant.
it('preserves Warrant revisions, standing and action history after source shutdown', async () => {
  const source = await startHarness();
  let sourceStopped = false;
  let restored: Harness | undefined;
  try {
    restored = await startHarness();
    const fixtures = await seedFixtures(source.adminPool);
    const dispatch = createFabricDispatcher(source.pool);
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
    const draft = async (alias: string) => {
      const { id } = await withTransaction(source.adminPool, (tx) =>
        tx.one<{ id: string }>('select uuidv7()::text as id'),
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
        contract_digest: sha(id),
        compilation_basis: sha(`basis-${id}`),
        canonical_ir: { schema: 'oh.war/ir/v1', intent: { problem: id } },
      });
      await act('authorize_warrant_contract', [id], {
        contract_digest: sha(id),
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
      await act('register_warrant_submission', [id], {
        submission_ref: 'S-1',
        artifact_refs: [],
        blocker_refs: [],
        deviation_refs: [],
        requested_next_action: 'verify',
      });
      await act('resolve_warrant', [id], { outcome: 'satisfied' });
    };
    const superseded = await draft('OW-WAR-9901');
    const successor = await draft('OW-WAR-9902');
    const disputed = await draft('OW-WAR-9903');
    const annulled = await draft('OW-WAR-9904');
    for (const id of [superseded, disputed, annulled]) await resolve(id);
    await act('supersede_warrant', [superseded], { superseded_by: successor });
    await act('dispute_warrant_resolution', [disputed], { dispute: 'fixture unresolved dispute' });
    await act('dispute_warrant_resolution', [annulled], { dispute: 'fixture upheld dispute' });
    await act('annul_warrant_resolution', [annulled], { annulment_basis: 'fixture withdrawal' });

    const keys = generateKeyPairSync('ed25519');
    const keyId = 'ow111-disposable-export-key';
    const first = signExportPackage(
      await withTransaction(source.adminPool, (tx) => createExport(tx)),
      { keyId, privateKey: keys.privateKey },
    );
    expect(first.manifest.counts['warrants']).toBe(4);
    expect(first.manifest.counts['warrant-contract-revisions']).toBe(6);
    expect(first.manifest.counts['actions']).toBeGreaterThan(20);
    expect(first.manifest.counts['audit-events']).toBeGreaterThan(20);
    await source.stop();
    sourceStopped = true;

    // Untrusted origins refuse before any Warrant becomes visible in the target.
    await expect(
      withTransaction(restored.adminPool, (tx) => importExport(tx, first)),
    ).rejects.toThrow(/untrusted_key/);
    const empty = await withTransaction(restored.adminPool, (tx) =>
      tx.one<{ count: string }>('select count(*)::text as count from work.warrant'),
    );
    expect(empty.count).toBe('0');
    await withTransaction(restored.adminPool, (tx) =>
      importExport(tx, first, { trustedManifestKeys: new Map([[keyId, keys.publicKey]]) }),
    );
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
    if (!sourceStopped) await source.stop();
    await restored?.stop();
  }
}, 180_000);
