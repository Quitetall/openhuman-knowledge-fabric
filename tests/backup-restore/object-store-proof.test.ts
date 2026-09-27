/**
 * The object-store verifier is told what to read, never what it should find.
 *
 * Until 2026-09-23 `restore-verify.sh` handed the host's verifier program the whole
 * authenticated export — digests included — and recorded object-store recovery as verified on
 * its exit code alone. A program that echoed the export's digests, or read nothing and exited
 * 0, produced a `verified` drill. These tests pin the in-repository half that replaced that:
 * the request carries no digests, and the answer is checked here against the export.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const PROOF = join(ROOT, 'scripts', 'lib', 'object-store-proof.mjs');
const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function exportWith(rows: readonly Record<string, unknown>[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'kf-object-proof-'));
  directories.push(directory);
  writeFileSync(join(directory, 'artifact-versions.json'), `${JSON.stringify(rows)}\n`);
  return directory;
}

function proof(command: 'request' | 'check', exportDirectory: string, file: string) {
  const r = spawnSync(process.execPath, [PROOF, command, exportDirectory, file], {
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
}

const ROWS = [
  { id: '1', sha256: A, size_bytes: '10', storage_uri: 's3://kf/a', storage_version: 'v1' },
  { id: '2', sha256: B, size_bytes: 20, storage_uri: 's3://kf/b', storage_version: 'v7' },
  { id: '3', sha256: B, size_bytes: 20, storage_uri: null, storage_version: null },
];

describe('the request', () => {
  it('names every stored object and carries no digest or size', () => {
    const exported = exportWith(ROWS);
    const request = join(exported, 'request.jsonl');
    const r = proof('request', exported, request);
    expect(r.code, r.output).toBe(0);
    expect(r.output.trim()).toBe('2');
    const body = readFileSync(request, 'utf8');
    expect(
      body
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      { storage_uri: 's3://kf/a', storage_version: 'v1' },
      { storage_uri: 's3://kf/b', storage_version: 'v7' },
    ]);
    expect(body).not.toContain(A);
    expect(body).not.toContain('size');
  });
});

describe('the answer', () => {
  const line = (uri: string, version: string, sha256: string, size: number | string) =>
    `${JSON.stringify({ storage_uri: uri, storage_version: version, sha256, size_bytes: size })}\n`;

  function check(body: string) {
    const exported = exportWith(ROWS);
    const file = join(exported, 'proof.jsonl');
    writeFileSync(file, body);
    return proof('check', exported, file);
  }

  it('passes only an exact, complete, matching measurement', () => {
    expect(check(line('s3://kf/a', 'v1', A, 10) + line('s3://kf/b', 'v7', B, '20')).code).toBe(0);
  });

  it.each([
    ['an empty answer from a verifier that read nothing', '', 'have no measurement'],
    ['a missing object', line('s3://kf/a', 'v1', A, 10), 'have no measurement'],
    [
      'a wrong digest',
      line('s3://kf/a', 'v1', B, 10) + line('s3://kf/b', 'v7', B, 20),
      'the export records',
    ],
    [
      'a wrong size',
      line('s3://kf/a', 'v1', A, 11) + line('s3://kf/b', 'v7', B, 20),
      'the export records',
    ],
    [
      'an object nobody asked about',
      line('s3://kf/a', 'v1', A, 10) + line('s3://kf/b', 'v7', B, 20) + line('s3://x', 'v', A, 1),
      'not requested',
    ],
    [
      'a repeated object',
      line('s3://kf/a', 'v1', A, 10) + line('s3://kf/a', 'v1', A, 10),
      'repeats',
    ],
    ['non-JSON', 'OK\n', 'not JSON'],
  ])('refuses %s', (_what, body, reason) => {
    const r = check(body);
    expect(r.code).toBe(1);
    expect(r.output).toContain(reason);
  });
});

describe('restore-verify.sh uses it', () => {
  it('pins the verifier program, sends only the request, and checks the answer here', () => {
    const restore = readFileSync(join(ROOT, 'scripts', 'restore-verify.sh'), 'utf8');
    const pin = restore.indexOf('KF_OBJECT_STORE_VERIFY_PROGRAM_SHA256');
    const request = restore.indexOf('object-store-proof.mjs" request');
    const invoke = restore.indexOf(
      '"${VERIFY_COMMAND[@]}" "$OBJECT_STORE_REQUEST" "$OBJECT_STORE_PROOF"',
    );
    const check = restore.indexOf('object-store-proof.mjs" check');
    const verified = restore.indexOf('OBJECT_STORE_VERIFIED=true');
    for (const marker of [pin, request, invoke, check, verified]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(pin).toBeLessThan(invoke);
    expect(request).toBeLessThan(invoke);
    expect(invoke).toBeLessThan(check);
    expect(check).toBeLessThan(verified);
    // The export itself is never an argument to the host's program.
    expect(restore).not.toContain('"$KF_OBJECT_STORE_VERIFY_PROGRAM" "$VERIFIED_BACKUP/export"');
    expect(restore).not.toContain('"${VERIFY_COMMAND[@]}" "$VERIFIED_BACKUP/export"');
    // An operator-supplied override is still pinned: it is the one program not in the release.
    expect(restore.indexOf('VERIFY_COMMAND=("$KF_OBJECT_STORE_VERIFY_PROGRAM")')).toBeGreaterThan(
      pin,
    );
    const environment = readFileSync(join(ROOT, 'deploy', 'systemd', 'backup.env.example'), 'utf8');
    expect(environment).toMatch(/^# KF_OBJECT_STORE_VERIFY_PROGRAM_SHA256=/m);
  });
});
