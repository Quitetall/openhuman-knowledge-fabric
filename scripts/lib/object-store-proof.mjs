#!/usr/bin/env node
//
// The in-repository half of object-store restore verification.
//
// The object store is federated: its credentials and protocol belong to the deployment, so the
// program that reads it (`KF_OBJECT_STORE_VERIFY_PROGRAM`) is supplied by the host. Until
// 2026-09-23 restore-verify.sh handed that program the whole authenticated export — digests
// included — and trusted its exit code. A program that echoed the export's own digests back,
// or that exited 0 having read nothing, produced a `verified` drill.
//
// Now the program is told only WHICH objects to read, never what they should contain:
//
//   request  <export-dir> <request.jsonl>   one {"storage_uri","storage_version"} per stored
//                                           artifact version, and nothing else
//   check    <export-dir> <proof.jsonl>     the program's answer must name every requested
//                                           object exactly once, with the SHA-256 and size it
//                                           measured, and those must equal the export's
//
// So a verifier cannot pass without learning each object's digest from somewhere other than
// the export — which, for an honest one, is the store.
//
// Exit 0 when the proof covers the request exactly; 1 with a reason otherwise; 64 on misuse.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_PROOF_BYTES = 16 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`object-store proof refused: ${message}\n`);
  process.exit(1);
}

function key(uri, version) {
  return JSON.stringify([uri, version]);
}

/** Stored artifact versions from the authenticated export: the ones with bytes in the store. */
function storedVersions(exportDirectory) {
  const rows = JSON.parse(readFileSync(join(exportDirectory, 'artifact-versions.json'), 'utf8'));
  if (!Array.isArray(rows)) fail('artifact-versions.json is not an array');
  const expected = new Map();
  for (const row of rows) {
    if (row.storage_uri === null || row.storage_uri === undefined) continue;
    if (typeof row.storage_uri !== 'string' || typeof row.sha256 !== 'string') {
      fail(`artifact version ${String(row.id)} has a malformed storage_uri or sha256`);
    }
    const version = row.storage_version === null ? null : String(row.storage_version);
    expected.set(key(row.storage_uri, version), {
      storage_uri: row.storage_uri,
      storage_version: version,
      sha256: row.sha256,
      size_bytes: String(row.size_bytes),
    });
  }
  return expected;
}

const [command, exportDirectory, path] = process.argv.slice(2);
if (exportDirectory === undefined || path === undefined) {
  process.stderr.write('usage: object-store-proof.mjs request|check <export-dir> <file>\n');
  process.exit(64);
}
const expected = storedVersions(exportDirectory);

if (command === 'request') {
  const lines = [...expected.values()]
    .map(({ storage_uri, storage_version }) => JSON.stringify({ storage_uri, storage_version }))
    .sort();
  writeFileSync(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { mode: 0o600 });
  process.stdout.write(`${lines.length}\n`);
} else if (command === 'check') {
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text) > MAX_PROOF_BYTES) fail('proof exceeds 16 MiB');
  const seen = new Set();
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      fail(`line ${index + 1} is not JSON`);
    }
    if (typeof entry !== 'object' || entry === null) fail(`line ${index + 1} is not an object`);
    const version = entry.storage_version === null ? null : String(entry.storage_version);
    const id = key(entry.storage_uri, version);
    const want = expected.get(id);
    if (want === undefined) fail(`line ${index + 1} names an object that was not requested`);
    if (seen.has(id)) fail(`line ${index + 1} repeats ${entry.storage_uri}`);
    seen.add(id);
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail(`line ${index + 1} has no measured sha256`);
    }
    if (entry.sha256 !== want.sha256) {
      fail(`${entry.storage_uri} measured ${entry.sha256}, the export records ${want.sha256}`);
    }
    if (String(entry.size_bytes) !== want.size_bytes) {
      fail(
        `${entry.storage_uri} measured ${String(entry.size_bytes)} bytes, the export records ${want.size_bytes}`,
      );
    }
  }
  const missing = [...expected.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    fail(
      `${missing.length} requested object(s) have no measurement, e.g. ${JSON.parse(missing[0])[0]}`,
    );
  }
  process.stdout.write(`${seen.size}\n`);
} else {
  process.stderr.write('usage: object-store-proof.mjs request|check <export-dir> <file>\n');
  process.exit(64);
}
