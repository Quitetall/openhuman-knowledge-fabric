import { canonicalize } from '@kf/canonicalization';
import type { ExportFile, ExportManifestSignature, VerificationFinding } from './types.js';
import { EXPORT_MANIFEST_SIGNATURE_PATH } from './types.js';
import {
  MANIFEST_SIGNATURE_FORMAT,
  SAFE_KEY_ID,
  SHA256,
  canonicalBase64,
  isRecord,
} from './format.js';

export function inspectManifestSignature(
  signatureFile: ExportFile,
  findings: VerificationFinding[],
): ExportManifestSignature | undefined {
  let value: unknown;
  try {
    value = JSON.parse(signatureFile.content) as unknown;
  } catch {
    findings.push({
      path: EXPORT_MANIFEST_SIGNATURE_PATH,
      problem: 'malformed_signature',
      detail: 'signature sidecar is not JSON',
    });
    return undefined;
  }
  if (!isRecord(value)) {
    findings.push({
      path: EXPORT_MANIFEST_SIGNATURE_PATH,
      problem: 'malformed_signature',
      detail: 'signature sidecar must be an object',
    });
    return undefined;
  }

  const expectedKeys = [
    'algorithm',
    'format_version',
    'key_id',
    'manifest_sha256',
    'signature_base64',
  ];
  const actualKeys = Object.keys(value).sort();
  const canonicalContent = `${canonicalize(value)}\n`;
  const structurallyValid =
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    signatureFile.content === canonicalContent &&
    value['format_version'] === MANIFEST_SIGNATURE_FORMAT &&
    value['algorithm'] === 'Ed25519' &&
    typeof value['key_id'] === 'string' &&
    SAFE_KEY_ID.test(value['key_id']) &&
    typeof value['manifest_sha256'] === 'string' &&
    SHA256.test(value['manifest_sha256']) &&
    typeof value['signature_base64'] === 'string' &&
    canonicalBase64(value['signature_base64']) &&
    Buffer.from(value['signature_base64'], 'base64').byteLength === 64;

  if (!structurallyValid) {
    findings.push({
      path: EXPORT_MANIFEST_SIGNATURE_PATH,
      problem: 'malformed_signature',
      detail:
        'signature sidecar must use its closed canonical schema, safe key id, SHA-256 digest, ' +
        'and one canonical-base64 Ed25519 signature',
    });
    return undefined;
  }
  return value as unknown as ExportManifestSignature;
}
