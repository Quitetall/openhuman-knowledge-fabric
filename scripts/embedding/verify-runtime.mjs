#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FORMAT,
  MANIFEST,
  digest,
  hostRecord,
  protectedPath,
  sameRecords,
  treeRecords,
} from './runtime-inventory.mjs';

export function verifyRuntime(root, expected) {
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('runtime_pin_invalid');
  protectedPath(root);
  const manifestPath = join(root, MANIFEST);
  protectedPath(manifestPath);
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('runtime_manifest_invalid');
  const bytes = readFileSync(manifestPath);
  if (digest(bytes) !== expected) throw new Error('runtime_manifest_digest_mismatch');
  const manifest = JSON.parse(bytes);
  if (
    manifest.format !== FORMAT ||
    manifest.python !== 'bin/python3.13' ||
    !Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.hostFiles) ||
    !Array.isArray(manifest.native)
  )
    throw new Error('runtime_manifest_shape_invalid');
  const entries = treeRecords(root);
  for (const entry of entries) protectedPath(join(root, entry.path));
  sameRecords(entries, manifest.entries);
  sameRecords(
    manifest.hostFiles.map((entry) => hostRecord(entry.path)),
    manifest.hostFiles,
  );
  return join(root, manifest.python);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('runtime_usage_invalid');
    verifyRuntime(...process.argv.slice(2));
    process.stdout.write('embedding_runtime_verified\n');
  } catch {
    process.stderr.write('embedding_runtime_verification_refused\n');
    process.exitCode = 1;
  }
}
