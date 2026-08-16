import { createPublicKey, type KeyObject } from 'node:crypto';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import type { ExportFile, ExportPackage, VerificationFinding } from './types.js';
import { EXPORT_MANIFEST_SIGNATURE_PATH } from './types.js';
import {
  CHECKPOINT_PUBLIC_KEY_EXPORT_PATH,
  MANIFEST_PATH,
  PRIVATE_KEY_PEM,
  SHA256,
  isRecord,
  safeExportPath,
} from './format.js';

/** Verify the manifest bytes and every file digest, without making an authenticity claim. */
export function verifyPackageContents(pkg: ExportPackage): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const byPath = new Map<string, ExportFile>();

  for (const exportFile of pkg.files) {
    if (byPath.has(exportFile.path)) {
      findings.push({
        path: exportFile.path,
        problem: 'duplicate',
        detail: 'path occurs more than once in the package',
      });
    } else {
      byPath.set(exportFile.path, exportFile);
    }
  }

  const manifestFile = byPath.get(MANIFEST_PATH);
  const manifest: unknown = pkg.manifest;
  if (manifestFile === undefined) {
    findings.push({ path: MANIFEST_PATH, problem: 'missing', detail: 'package has no manifest' });
  } else {
    try {
      const parsed = JSON.parse(manifestFile.content) as unknown;
      const expected = `${canonicalize(manifest)}\n`;
      if (
        !isRecord(parsed) ||
        manifestFile.content !== expected ||
        canonicalize(parsed) !== canonicalize(manifest)
      ) {
        findings.push({
          path: MANIFEST_PATH,
          problem: 'manifest_mismatch',
          detail: 'manifest.json must be the exact canonical bytes of package.manifest',
        });
      }
    } catch {
      findings.push({
        path: MANIFEST_PATH,
        problem: 'manifest_mismatch',
        detail: 'manifest.json is not the exact canonical JSON form of package.manifest',
      });
    }
  }

  if (!isRecord(manifest)) {
    findings.push({
      path: MANIFEST_PATH,
      problem: 'manifest_mismatch',
      detail: 'parsed manifest must be an object',
    });
    return findings;
  }
  if (!Array.isArray(manifest['files'])) {
    findings.push({
      path: MANIFEST_PATH,
      problem: 'manifest_mismatch',
      detail: 'manifest.files must be an array',
    });
    return findings;
  }

  const listed = new Set<string>();
  for (const unknownEntry of manifest['files']) {
    if (!isRecord(unknownEntry)) {
      findings.push({
        path: MANIFEST_PATH,
        problem: 'manifest_mismatch',
        detail: 'manifest.files entries must be objects',
      });
      continue;
    }
    const { path, size_bytes: sizeBytes, sha256 } = unknownEntry;
    if (
      typeof path !== 'string' ||
      !safeExportPath(path) ||
      !Number.isSafeInteger(sizeBytes) ||
      (sizeBytes as number) < 0 ||
      typeof sha256 !== 'string' ||
      !SHA256.test(sha256)
    ) {
      findings.push({
        path: MANIFEST_PATH,
        problem: 'manifest_mismatch',
        detail: 'manifest.files contains an invalid path, size, or SHA-256 digest',
      });
      continue;
    }
    if (path === MANIFEST_PATH || path === EXPORT_MANIFEST_SIGNATURE_PATH) {
      findings.push({
        path,
        problem: 'manifest_mismatch',
        detail: 'manifest and signature sidecars cannot list themselves',
      });
      continue;
    }
    if (listed.has(path)) {
      findings.push({
        path,
        problem: 'manifest_mismatch',
        detail: 'manifest lists this path more than once',
      });
      continue;
    }
    listed.add(path);

    const f = byPath.get(path);
    if (f === undefined) {
      findings.push({ path, problem: 'missing', detail: 'listed but absent' });
      continue;
    }
    const bytes = Buffer.from(f.content, 'utf8');
    if (bytes.length !== sizeBytes) {
      findings.push({
        path,
        problem: 'size_mismatch',
        detail: `manifest says ${String(sizeBytes)}, file is ${bytes.length}`,
      });
    }
    const actual = digestBytes(bytes);
    if (actual !== sha256) {
      findings.push({
        path,
        problem: 'digest_mismatch',
        detail: `manifest says ${sha256}, file hashes to ${actual}`,
      });
    }
  }

  // A file present but unlisted is as much a problem as one listed and absent: it is
  // content nobody vouched for.
  for (const f of pkg.files) {
    if (
      f.path !== MANIFEST_PATH &&
      f.path !== EXPORT_MANIFEST_SIGNATURE_PATH &&
      !listed.has(f.path)
    ) {
      findings.push({ path: f.path, problem: 'unlisted', detail: 'present but not in manifest' });
    }
  }
  return findings;
}

export function checkpointPublicKeyProblem(path: string, content: string): string | undefined {
  if (CHECKPOINT_PUBLIC_KEY_EXPORT_PATH.exec(path) === null) {
    return 'checkpoint public-key files must use trust/checkpoint/<signing-key-id>.pub';
  }
  if (PRIVATE_KEY_PEM.test(content)) return 'checkpoint public-key file contains private material';
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(content);
  } catch {
    return 'checkpoint public-key file is not public-key PEM';
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    return 'checkpoint public-key file is not Ed25519';
  }
  return undefined;
}
