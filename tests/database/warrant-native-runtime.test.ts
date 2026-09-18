import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  createExport,
  importExport,
  readWarrantRuntimeEvidence,
  signExportPackage,
} from '@kf/export';
import { seedFixtures, startHarness, type Harness } from './harness.js';

// Real retained native service receipt, fixture-only database permissions.
// No production approval, model call, or claim that the no-op verifies a feature.
it('preserves a native service receipt and dispatch after provider source shutdown', async () => {
  const source = await startHarness();
  let target: Harness | undefined;
  let stopped = false;
  try {
    target = await startHarness();
    const fixtures = await seedFixtures(source.adminPool);
    const dispatch = createFabricDispatcher(source.pool);
    type Payload = NonNullable<Parameters<typeof dispatch>[0]['payload']>;
    const fixture: {
      canonical_ir: Payload;
      dispatch: {
        warrant_ref: string;
        contract_digest: string;
        workspace_basis_digest: string;
        dispatch_digest: string;
      };
      receipt: Payload & { receipt_digest: string; subject_digests: string[] };
    } = JSON.parse(
      await readFile(
        new URL('../fixtures/openwarrant-preservation/ow66-native-service.json', import.meta.url),
        'utf8',
      ),
    );
    const warrantId = fixture.dispatch.warrant_ref.slice('war://'.length);
    expect(fixture.receipt.subject_digests).toContain(
      `dispatch:${fixture.dispatch.dispatch_digest}`,
    );
    const act = async (actionType: string, targetIds: string[], payload: Payload) => {
      const result = await dispatch({
        actionType,
        targetIds,
        payload,
        actorId: fixtures.reviewerId,
        actingRoleId: fixtures.reviewerRoleId,
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: randomUUID(),
        reason: 'OW111 disposable native receipt retention fixture',
      });
      expect(result.status).toBe('applied');
    };
    await act('create_warrant_draft', [], {
      warrant_uuid: warrantId,
      repository: 'ow111-native-fixture',
      local_alias: 'OW-WAR-0066',
      title: 'Native service receipt preservation fixture',
      profile: 'delivery',
      assurance_level: 'controlled',
    });
    await act('submit_warrant', [warrantId], {
      contract_digest: fixture.dispatch.contract_digest,
      compilation_basis: fixture.dispatch.workspace_basis_digest,
      canonical_ir: fixture.canonical_ir,
    });
    await act('authorize_warrant_contract', [warrantId], {
      contract_digest: fixture.dispatch.contract_digest,
      authorization_meaning: 'fixture database permission only',
      policy_basis: 'disposable OW111 test',
    });
    await act('record_warrant_preflight', [warrantId], {
      receipt_digest: 'a'.repeat(64),
      outcomes: { 'fixture.ready': 'passed' },
      readiness: 'ready',
      performed_at: new Date().toISOString(),
    });
    await act('authorize_warrant_dispatch', [warrantId], {
      dispatch_digest: fixture.dispatch.dispatch_digest,
      performer_ref: 'fixture://ow111-service',
    });
    await act('attach_warrant_runtime_receipt', [warrantId], {
      adapter: 'oh.war/gate-run-receipt/v1',
      dispatch_digest: fixture.dispatch.dispatch_digest,
      receipt_digest: fixture.receipt.receipt_digest.replace(/^sha256:/, ''),
      terminal_status: 'completed',
      artifact_refs: [],
      receipt: fixture.receipt,
    });
    const keys = generateKeyPairSync('ed25519');
    const keyId = 'disposable-native-receipt-fixture';
    const first = signExportPackage(
      await withTransaction(source.adminPool, (tx) => createExport(tx)),
      { keyId, privateKey: keys.privateKey },
    );
    const trust = new Map([[keyId, keys.publicKey]]);
    await source.stop();
    stopped = true;
    const evidence = readWarrantRuntimeEvidence(first, warrantId, trust, [fixture.dispatch]);
    expect(evidence.dispatchesWithoutReceipts).toEqual([]);
    expect(evidence.unmappedDispatchDigests).toEqual([]);
    expect(evidence.receipts).toHaveLength(1);
    const body = evidence.receipts[0]?.['receipt'] as { $kf_type: string; text: string };
    expect(body.$kf_type).toBe('postgres.jsonb');
    expect(JSON.parse(body.text)).toEqual(fixture.receipt);
    await expect(
      withTransaction(target.adminPool, (tx) => importExport(tx, first)),
    ).rejects.toThrow(/untrusted_key/);
    await withTransaction(target.adminPool, (tx) =>
      importExport(tx, first, { trustedManifestKeys: trust }),
    );
    const second = await withTransaction(target.adminPool, (tx) => createExport(tx));
    expect(second.manifest.database_snapshot_sha256).toBe(first.manifest.database_snapshot_sha256);
    expect(second.files.find((f) => f.path === 'warrant-runtime-receipts.json')).toEqual(
      first.files.find((f) => f.path === 'warrant-runtime-receipts.json'),
    );
    expect(second.files.find((f) => f.path === 'warrant-dispatches.json')).toEqual(
      first.files.find((f) => f.path === 'warrant-dispatches.json'),
    );
  } finally {
    try {
      if (!stopped) await source.stop();
    } finally {
      await target?.stop();
    }
  }
}, 180_000);
