import { verify as edVerify } from 'node:crypto';
import { canonicalBytes, digestBytes } from '@kf/canonicalization';
import type { ExportPackage, ExportVerificationOptions, VerificationFinding } from './types.js';
import {
  EXPORT_FORMAT_VERSION,
  EXPORT_MANIFEST_SIGNATURE_PATH,
  LEGACY_UNSIGNED_EXPORT_WARNING,
} from './types.js';
import { MANIFEST_PATH, isRecord } from './format.js';
import { inspectManifestSignature } from './signature-sidecar.js';
import { verifyPackageContents } from './verification-content.js';
import { verifyV2PackageShape } from './verification-shape.js';

/** Check file integrity and authenticate the manifest against historical trusted keys. */
export function verifyExport(
  pkg: ExportPackage,
  options: ExportVerificationOptions = {},
): VerificationFinding[] {
  const findings = verifyPackageContents(pkg);
  const signatureFiles = pkg.files.filter((entry) => entry.path === EXPORT_MANIFEST_SIGNATURE_PATH);
  if (!isRecord(pkg.manifest) || !Array.isArray(pkg.manifest['files'])) return findings;

  if (pkg.manifest.format_version === '1') {
    if (signatureFiles.length > 0) {
      findings.push({
        path: EXPORT_MANIFEST_SIGNATURE_PATH,
        problem: 'malformed_signature',
        detail: 'legacy format v1 is supported only in its original unsigned form',
      });
    } else if (options.allowUnsignedLegacyV1 === true && typeof options.onWarning === 'function') {
      options.onWarning(LEGACY_UNSIGNED_EXPORT_WARNING);
    } else {
      findings.push({
        path: MANIFEST_PATH,
        problem: 'unsigned_legacy',
        detail: 'unsigned format v1 requires explicit opt-in and a warning callback',
      });
    }
    return findings;
  }

  if (pkg.manifest.format_version !== EXPORT_FORMAT_VERSION) {
    findings.push({
      path: MANIFEST_PATH,
      problem: 'unsupported_format',
      detail: `unsupported export format version ${JSON.stringify(pkg.manifest.format_version)}`,
    });
    return findings;
  }

  findings.push(...verifyV2PackageShape(pkg));

  const signatureFile = signatureFiles[0];
  if (signatureFile === undefined) {
    findings.push({
      path: EXPORT_MANIFEST_SIGNATURE_PATH,
      problem: 'missing_signature',
      detail: 'authenticated format v2 requires a manifest signature sidecar',
    });
    return findings;
  }
  if (signatureFiles.length !== 1) return findings;

  const signature = inspectManifestSignature(signatureFile, findings);
  if (signature === undefined) return findings;

  let manifestBytes: Buffer;
  try {
    manifestBytes = canonicalBytes(pkg.manifest);
  } catch {
    findings.push({
      path: MANIFEST_PATH,
      problem: 'manifest_mismatch',
      detail: 'parsed manifest has no RFC 8785 canonical form',
    });
    return findings;
  }
  const manifestDigest = digestBytes(manifestBytes);
  if (signature.manifest_sha256 !== manifestDigest) {
    findings.push({
      path: EXPORT_MANIFEST_SIGNATURE_PATH,
      problem: 'signature_invalid',
      detail: `sidecar names manifest digest ${signature.manifest_sha256}, actual is ${manifestDigest}`,
    });
    return findings;
  }

  const publicKey = options.trustedManifestKeys?.get(signature.key_id);
  if (publicKey === undefined) {
    findings.push({
      path: EXPORT_MANIFEST_SIGNATURE_PATH,
      problem: 'untrusted_key',
      detail: `no trusted historical public key for ${signature.key_id}`,
    });
    return findings;
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    findings.push({
      path: EXPORT_MANIFEST_SIGNATURE_PATH,
      problem: 'signature_invalid',
      detail: `trusted key ${signature.key_id} is not a public Ed25519 key`,
    });
    return findings;
  }

  try {
    if (
      !edVerify(null, manifestBytes, publicKey, Buffer.from(signature.signature_base64, 'base64'))
    ) {
      findings.push({
        path: EXPORT_MANIFEST_SIGNATURE_PATH,
        problem: 'signature_invalid',
        detail: `manifest signature does not verify with trusted key ${signature.key_id}`,
      });
    }
  } catch {
    findings.push({
      path: EXPORT_MANIFEST_SIGNATURE_PATH,
      problem: 'signature_invalid',
      detail: `manifest signature does not verify with trusted key ${signature.key_id}`,
    });
  }
  return findings;
}
