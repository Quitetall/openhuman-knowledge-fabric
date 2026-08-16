import { verify, type KeyObject } from 'node:crypto';
import { digestBytes } from '@kf/canonicalization';
import { inspectPublicationBundle } from './inspect.js';
import { canonicalManifestBytes } from './validation.js';

/** Verify signature, completeness, and exact file bytes. Empty findings means valid. */
export function verifyPublicationBundle(
  input: unknown,
  publicKeys: ReadonlyMap<string, KeyObject>,
): string[] {
  const inspected = inspectPublicationBundle(input);
  const findings = [...inspected.findings];
  const bundle = inspected.bundle;
  if (bundle === undefined) return findings;

  const key = publicKeys.get(bundle.signature.key_id);
  if (key === undefined) {
    findings.push(`unknown publication signing key ${bundle.signature.key_id}`);
  } else if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    findings.push(`publication signing key ${bundle.signature.key_id} must be public Ed25519`);
  } else if (inspected.signatureUsable) {
    try {
      const validSignature = verify(
        null,
        canonicalManifestBytes(bundle.manifest),
        key,
        Buffer.from(bundle.signature.value_base64, 'base64'),
      );
      if (!validSignature) findings.push('manifest signature invalid');
    } catch {
      findings.push('manifest signature invalid');
    }
  }

  const expected = new Map<string, (typeof bundle.manifest.files)[number]>();
  for (const entry of bundle.manifest.files) {
    if (expected.has(entry.path)) findings.push(`${entry.path}: duplicate manifest path`);
    else expected.set(entry.path, entry);
  }
  const actual = new Map<string, (typeof bundle.files)[number]>();
  for (const file of bundle.files) {
    if (actual.has(file.path)) findings.push(`${file.path}: duplicate supplied path`);
    else actual.set(file.path, file);
  }
  for (const [path, entry] of expected) {
    const file = actual.get(path);
    if (file === undefined) {
      findings.push(`${path}: missing`);
      continue;
    }
    if (file.mediaType !== entry.media_type) findings.push(`${path}: media type mismatch`);
    if (file.bytes.byteLength !== entry.size_bytes) findings.push(`${path}: size mismatch`);
    if (digestBytes(file.bytes) !== entry.sha256) findings.push(`${path}: digest mismatch`);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) findings.push(`${path}: unlisted`);
  }
  return findings;
}
