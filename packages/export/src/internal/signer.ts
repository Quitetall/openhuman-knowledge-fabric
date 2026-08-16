import { sign as edSign } from 'node:crypto';
import {
  canonicalBytes,
  canonicalize,
  compareCanonicalText,
  digestBytes,
} from '@kf/canonicalization';
import type {
  ExportManifest,
  ExportManifestSignature,
  ExportManifestSigningKey,
  ExportPackage,
  SignExportOptions,
} from './types.js';
import { EXPORT_FORMAT_VERSION, EXPORT_MANIFEST_SIGNATURE_PATH } from './types.js';
import { MANIFEST_PATH, MANIFEST_SIGNATURE_FORMAT, SAFE_KEY_ID, safeExportPath } from './format.js';
import { checkpointPublicKeyProblem, verifyPackageContents } from './verification-content.js';
import { verifyV2PackageShape } from './verification-shape.js';

/**
 * Add optional public custody material, then sign the exact RFC 8785 manifest bytes.
 *
 * The signature sidecar is intentionally not listed by the manifest: listing it would create
 * a self-reference. Its signature authenticates the manifest, which authenticates every other
 * file, including archived public verification keys. Private key material must never be passed
 * as an authenticated file.
 */
export function signExportPackage(
  pkg: ExportPackage,
  signingKey: ExportManifestSigningKey,
  options: SignExportOptions = {},
): ExportPackage {
  if (pkg.manifest.format_version !== EXPORT_FORMAT_VERSION) {
    throw new Error('only export format v2 can receive an authenticated manifest signature');
  }
  if (!SAFE_KEY_ID.test(signingKey.keyId)) {
    throw new Error('preservation signing key id must be a safe non-empty identifier');
  }
  if (
    signingKey.privateKey.type !== 'private' ||
    signingKey.privateKey.asymmetricKeyType !== 'ed25519'
  ) {
    throw new Error('preservation signing key must be a private Ed25519 key');
  }

  const contentFindings = [...verifyPackageContents(pkg), ...verifyV2PackageShape(pkg)];
  if (contentFindings.length > 0) {
    throw new Error(
      `refusing to sign a malformed export: ${contentFindings
        .map((finding) => `${finding.path} ${finding.problem} (${finding.detail})`)
        .join(', ')}`,
    );
  }

  const dataFiles = pkg.files.filter(
    (entry) => entry.path !== MANIFEST_PATH && entry.path !== EXPORT_MANIFEST_SIGNATURE_PATH,
  );
  const paths = new Set(dataFiles.map((entry) => entry.path));
  for (const authenticatedFile of options.authenticatedFiles ?? []) {
    if (
      !safeExportPath(authenticatedFile.path) ||
      authenticatedFile.path === MANIFEST_PATH ||
      authenticatedFile.path === EXPORT_MANIFEST_SIGNATURE_PATH
    ) {
      throw new Error(
        `refusing unsafe authenticated export path ${JSON.stringify(authenticatedFile.path)}`,
      );
    }
    if (paths.has(authenticatedFile.path)) {
      throw new Error(`refusing duplicate authenticated export path ${authenticatedFile.path}`);
    }
    const checkpointProblem = checkpointPublicKeyProblem(
      authenticatedFile.path,
      authenticatedFile.content,
    );
    if (checkpointProblem !== undefined) {
      throw new Error(`${authenticatedFile.path}: ${checkpointProblem}`);
    }
    paths.add(authenticatedFile.path);
    dataFiles.push(authenticatedFile);
  }
  dataFiles.sort((left, right) => compareCanonicalText(left.path, right.path));

  const manifest: ExportManifest = {
    ...pkg.manifest,
    files: dataFiles.map((entry) => {
      const bytes = Buffer.from(entry.content, 'utf8');
      return { path: entry.path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
    }),
  };
  const manifestBytes = canonicalBytes(manifest);
  const signature: ExportManifestSignature = {
    format_version: MANIFEST_SIGNATURE_FORMAT,
    algorithm: 'Ed25519',
    key_id: signingKey.keyId,
    manifest_sha256: digestBytes(manifestBytes),
    signature_base64: edSign(null, manifestBytes, signingKey.privateKey).toString('base64'),
  };
  return {
    manifest,
    files: [
      ...dataFiles,
      { path: MANIFEST_PATH, content: `${canonicalize(manifest)}\n` },
      { path: EXPORT_MANIFEST_SIGNATURE_PATH, content: `${canonicalize(signature)}\n` },
    ].sort((left, right) => compareCanonicalText(left.path, right.path)),
  };
}
