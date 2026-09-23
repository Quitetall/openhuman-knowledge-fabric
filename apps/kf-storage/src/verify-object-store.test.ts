/**
 * The in-release object-store verifier satisfies the request/proof contract end to end.
 *
 * Until 2026-09-23 a host had to write this program itself, and a host that had not recorded
 * every restore drill `partial`. These run the real request writer and the real proof checker
 * (`scripts/lib/object-store-proof.mjs`) around `measureRequested`, against an in-memory store,
 * so the default can only pass by measuring the bytes the store actually holds.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from '@kf/artifacts';
import { measureRequested, parseRequest, storeFromEnvironment } from './verify-object-store.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PROOF = join(ROOT, 'scripts', 'lib', 'object-store-proof.mjs');
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

type Readable = Pick<InMemoryObjectStore, 'head' | 'read'>;

async function drill(wrap: (store: InMemoryObjectStore) => Readable = (store) => store) {
  const store = new InMemoryObjectStore();
  const first = Buffer.from('first evidence\n');
  const second = Buffer.from('second, longer piece of evidence\n');
  const a = await store.put('ingest/org/a', first, 'text/plain');
  const b = await store.put('document-imports/org/b', second, 'text/plain');

  const exported = mkdtempSync(join(tmpdir(), 'kf-verify-object-store-'));
  directories.push(exported);
  writeFileSync(
    join(exported, 'artifact-versions.json'),
    JSON.stringify([
      {
        id: '1',
        sha256: sha256(first),
        size_bytes: first.length,
        storage_uri: 'ingest/org/a',
        storage_version: a.versionId ?? null,
      },
      {
        id: '2',
        sha256: sha256(second),
        size_bytes: second.length,
        storage_uri: 'document-imports/org/b',
        storage_version: b.versionId ?? null,
      },
    ]),
  );
  const request = join(exported, 'request.jsonl');
  const proof = join(exported, 'proof.jsonl');
  const requested = spawnSync(process.execPath, [PROOF, 'request', exported, request]);
  expect(requested.status, String(requested.stderr)).toBe(0);

  const { measured, failures } = await measureRequested(
    parseRequest(readFileSync(request, 'utf8')),
    wrap(store),
  );
  writeFileSync(proof, measured.map((line) => `${JSON.stringify(line)}\n`).join(''));
  const checked = spawnSync(process.execPath, [PROOF, 'check', exported, proof], {
    encoding: 'utf8',
  });
  return { failures, code: checked.status, output: `${checked.stdout}${checked.stderr}` };
}

describe('the in-release object-store verifier', () => {
  it('produces a proof the checker accepts when the store holds the recorded bytes', async () => {
    const result = await drill();
    expect(result.failures).toEqual([]);
    expect(result.code, result.output).toBe(0);
    expect(result.output.trim()).toBe('2');
  });

  it('reports what the store holds, so replaced bytes fail the check', async () => {
    // A store whose recorded version now serves other bytes — the corruption a drill exists
    // to find. The verifier reports what it read, and the checker refuses it.
    const result = await drill((store) => ({
      head: (key, version) => store.head(key, version),
      read: async (key, version, max) =>
        key === 'ingest/org/a'
          ? Buffer.from('something else entirely')
          : store.read(key, version, max),
    }));
    expect(result.code).toBe(1);
    expect(result.output).toContain('the export records');
  });

  it('names an object it could not read and leaves it out of the proof', async () => {
    const store = new InMemoryObjectStore();
    const { measured, failures } = await measureRequested(
      [{ storage_uri: 'ingest/org/missing', storage_version: null }],
      store,
    );
    expect(measured).toEqual([]);
    expect(failures).toEqual(['ingest/org/missing: not found']);
  });

  it('refuses an inline secret: the credential comes from an owner-only file', () => {
    expect(() =>
      storeFromEnvironment({
        S3_ENDPOINT: 'http://127.0.0.1:9',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY_ID: 'drill-reader',
        S3_BUCKET_ARTIFACTS: 'kf-artifacts',
        S3_SECRET_ACCESS_KEY: 'inline-value',
      }),
    ).toThrow(/S3_SECRET_ACCESS_KEY_FILE|inline/);
  });
});
