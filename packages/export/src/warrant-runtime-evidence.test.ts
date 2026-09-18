import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli/run.js';
import { writePackage } from './cli/package-io.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import { expect, it, vi } from 'vitest';
import {
  PRESERVATION_IMPORT_TARGETS,
  readWarrantRuntimeEvidence,
  recomputeDatabaseSnapshotDigest,
  signExportPackage,
  type ExportManifest,
} from './index.js';

const keys = generateKeyPairSync('ed25519');
const trust = new Map([['fixture', keys.publicKey]]);
const dispatchDigest = 'a'.repeat(64);
const receiptDigest = 'b'.repeat(64);

function fixture(change: (sections: Record<string, Record<string, unknown>[]>) => void = () => {}) {
  const sections: Record<string, Record<string, unknown>[]> = {
    warrants: [{ id: 'w1' }],
    'warrant-contract-revisions': [{ warrant_id: 'w1', revision_no: 1 }],
    'warrant-dispatches': [
      { warrant_id: 'w1', dispatch_digest: dispatchDigest, authorized_revision: 1 },
    ],
    'warrant-runtime-receipts': [
      {
        warrant_id: 'w1',
        dispatch_digest: dispatchDigest,
        receipt_digest: receiptDigest,
        terminal_status: 'failed',
      },
    ],
  };
  change(sections);
  const files = [
    { path: 'ontology/registry.json', content: '{}\n' },
    ...Object.keys(PRESERVATION_IMPORT_TARGETS).map((section) => ({
      path: `${section}.json`,
      content: `${canonicalize(sections[section] ?? [])}\n`,
    })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest: ExportManifest = {
    format_version: '2',
    ontology_version: 'fixture',
    ontology_digest: 'c'.repeat(64),
    schema_version: 'fixture',
    audit_from_seq: null,
    audit_to_seq: null,
    database_snapshot_sha256: recomputeDatabaseSnapshotDigest(files),
    counts: Object.fromEntries(
      Object.keys(PRESERVATION_IMPORT_TARGETS).map((s) => [s, (sections[s] ?? []).length]),
    ),
    files: files.map((f) => ({
      path: f.path,
      size_bytes: Buffer.byteLength(f.content),
      sha256: digestBytes(Buffer.from(f.content)),
    })),
  };
  return signExportPackage(
    {
      manifest,
      files: [...files, { path: 'manifest.json', content: `${canonicalize(manifest)}\n` }],
    },
    { keyId: 'fixture', privateKey: keys.privateKey },
  );
}

it('retains unsuccessful runtime records without treating them as assurance', () => {
  const evidence = readWarrantRuntimeEvidence(fixture(), 'w1', trust);
  expect(evidence.receipts[0]?.['terminal_status']).toBe('failed');
  expect(evidence.dispatches[0]?.['authorized_revision']).toBe(1);
});

it('refuses authenticated packages with broken receipt or contract bindings', () => {
  const wrongDispatch = fixture((s) => {
    s['warrant-runtime-receipts']![0]!['dispatch_digest'] = 'd'.repeat(64);
  });
  expect(() => readWarrantRuntimeEvidence(wrongDispatch, 'w1', trust)).toThrow(
    /invalid dispatch binding/,
  );
  const wrongRevision = fixture((s) => {
    s['warrant-dispatches']![0]!['authorized_revision'] = 2;
  });
  expect(() => readWarrantRuntimeEvidence(wrongRevision, 'w1', trust)).toThrow(
    /invalid contract binding/,
  );
  const duplicateReceipt = fixture((s) => {
    s['warrant-runtime-receipts']!.push({ ...s['warrant-runtime-receipts']![0]! });
  });
  expect(() => readWarrantRuntimeEvidence(duplicateReceipt, 'w1', trust)).toThrow(
    /duplicate digest/,
  );
});

it('binds a real OpenWarrant dispatch packet and exposes missing mappings', () => {
  const packet: Record<string, unknown> = JSON.parse(
    readFileSync(
      new URL(
        '../../../tests/fixtures/openwarrant-preservation/ow75-dispatch.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const warrantId = String(packet['warrant_ref']).slice('war://'.length);
  const pkg = fixture((sections) => {
    sections['warrants'] = [{ id: warrantId }];
    sections['warrant-contract-revisions'] = [
      {
        warrant_id: warrantId,
        revision_no: packet['contract_revision'],
        contract_digest: packet['contract_digest'],
      },
    ];
    sections['warrant-dispatches'] = [
      {
        warrant_id: warrantId,
        authorized_revision: packet['contract_revision'],
        dispatch_digest: packet['dispatch_digest'],
      },
    ];
    sections['warrant-runtime-receipts'] = [];
  });
  expect(readWarrantRuntimeEvidence(pkg, warrantId, trust).unmappedDispatchDigests).toEqual([
    packet['dispatch_digest'],
  ]);
  const result = readWarrantRuntimeEvidence(pkg, warrantId, trust, [packet]);
  expect(result.unmappedDispatchDigests).toEqual([]);
  expect(result.stageBindings).toEqual([packet]);
  expect(() =>
    readWarrantRuntimeEvidence(pkg, warrantId, trust, [{ ...packet, stage_id: 'OTHER' }]),
  ).toThrow(/digest or contract/);
  expect(() => readWarrantRuntimeEvidence(pkg, warrantId, trust, [packet, packet])).toThrow(
    /digest or contract/,
  );
  expect(() =>
    readWarrantRuntimeEvidence(pkg, warrantId, trust, [{ ...packet, warrant_ref: 'war://other' }]),
  ).toThrow(/Invalid runtime stage/);
});

it('exposes authenticated offline evidence through the CLI and refuses unsafe options', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kf-runtime-cli-'));
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const dir = join(root, 'export');
    const trustDir = join(root, 'trust');
    mkdirSync(dir);
    mkdirSync(trustDir);
    writePackage(dir, fixture());
    writeFileSync(
      join(trustDir, 'fixture.pub'),
      keys.publicKey.export({ type: 'spki', format: 'pem' }),
    );
    const args = ['runtime-evidence', dir, '--trust-store', trustDir, '--warrant-id', 'w1'];
    expect(await runCli(args)).toBe(0);
    const result: { unmappedDispatchDigests: string[] } = JSON.parse(
      String(output.mock.calls[0]?.[0]),
    );
    expect(result.unmappedDispatchDigests).toEqual([dispatchDigest]);
    const executable = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const actual = spawnSync(process.execPath, [executable, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, DATABASE_URL: 'postgresql://invalid.invalid:1/no_database' },
    });
    expect(actual.error).toBeUndefined();
    expect(actual.status, actual.stderr).toBe(0);
    expect(JSON.parse(actual.stdout)).toEqual(JSON.parse(String(output.mock.calls[0]?.[0])));

    await expect(runCli([...args, '--allow-unsigned-legacy-v1'])).rejects.toThrow(/accepts only/);
    expect(await runCli(['verify', dir, '--warrant-id', 'w1'])).toBe(2);
    const packet = join(root, 'packet.json');
    writeFileSync(packet, '{}');
    const link = join(root, 'link.json');
    symlinkSync(packet, link);
    await expect(runCli([...args, '--dispatch-file', link])).rejects.toThrow();
    writeFileSync(join(dir, 'warrant-runtime-receipts.json'), '[]\n');
    await expect(runCli(args)).rejects.toThrow(/package refused/);
    expect(output.mock.calls).toHaveLength(1);
  } finally {
    output.mockRestore();
    errors.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
