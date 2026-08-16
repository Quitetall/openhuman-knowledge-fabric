import type { SignedPublicationBundle } from './types.js';
import {
  inspectManifest,
  PUBLICATION_MANIFEST_KEYS,
  type ManifestInspection,
} from './inspect-manifest.js';
import {
  canonicalBase64,
  closedKeys,
  isRecord,
  requiredText,
  safePath,
  type ValidationState,
} from './validation.js';

export interface InspectedPublicationBundle {
  readonly bundle?: SignedPublicationBundle;
  readonly findings: string[];
  readonly signatureUsable: boolean;
}

export function inspectPublicationBundle(value: unknown): InspectedPublicationBundle {
  const state: ValidationState = { findings: [], structurallyValid: true };
  if (!isRecord(value)) {
    return { findings: ['bundle must be an object'], signatureUsable: false };
  }
  closedKeys(value, ['manifest', 'signature', 'files'], 'bundle', state.findings);
  if (!isRecord(value.manifest)) {
    state.findings.push('manifest must be an object');
    return { findings: state.findings, signatureUsable: false };
  }
  if (!isRecord(value.signature)) {
    state.findings.push('signature must be an object');
    return { findings: state.findings, signatureUsable: false };
  }
  if (!Array.isArray(value.files)) {
    state.findings.push('files must be an array');
    return { findings: state.findings, signatureUsable: false };
  }

  closedKeys(value.manifest, PUBLICATION_MANIFEST_KEYS, 'manifest', state.findings);
  closedKeys(value.signature, ['algorithm', 'key_id', 'value_base64'], 'signature', state.findings);
  const manifest = inspectManifest(value.manifest, state);
  const signatureUsable = inspectSignature(value.signature, state);
  inspectFiles(value.files, state);
  if (!canCastBundle(manifest, state)) {
    return { findings: state.findings, signatureUsable: false };
  }
  return {
    bundle: value as unknown as SignedPublicationBundle,
    findings: state.findings,
    signatureUsable,
  };
}

function inspectSignature(signature: Record<string, unknown>, state: ValidationState): boolean {
  const algorithm = requiredText(state, signature, 'algorithm', 'signature.algorithm');
  const keyId = requiredText(state, signature, 'key_id', 'signature.key_id');
  const signatureValue = requiredText(state, signature, 'value_base64', 'signature.value_base64');
  if (algorithm !== undefined && algorithm !== 'Ed25519') {
    state.findings.push('unsupported signature algorithm');
  }
  let usable = algorithm === 'Ed25519' && keyId !== undefined && signatureValue !== undefined;
  if (signatureValue !== undefined) {
    if (
      !canonicalBase64(signatureValue) ||
      Buffer.from(signatureValue, 'base64').byteLength !== 64
    ) {
      state.findings.push('signature.value_base64 must be one canonical Ed25519 signature');
      usable = false;
    }
  }
  return usable;
}

function inspectFiles(files: unknown[], state: ValidationState): void {
  if (files.length !== 1) {
    state.findings.push('files must contain exactly the authorized compiled view');
  }
  for (const [index, unknownFile] of files.entries()) {
    if (!isRecord(unknownFile)) {
      state.findings.push(`files[${index}] must be an object`);
      state.structurallyValid = false;
      continue;
    }
    closedKeys(unknownFile, ['path', 'mediaType', 'bytes'], `files[${index}]`, state.findings);
    const path = requiredText(state, unknownFile, 'path', `files[${index}].path`);
    requiredText(state, unknownFile, 'mediaType', `files[${index}].mediaType`);
    if (path !== undefined && !safePath(path)) state.findings.push(`${path}: unsafe supplied path`);
    if (!(unknownFile.bytes instanceof Uint8Array)) {
      state.findings.push(`${path ?? `files[${index}]`}: bytes must be a Uint8Array`);
      state.structurallyValid = false;
    }
  }
}

function canCastBundle(manifest: ManifestInspection, state: ValidationState): boolean {
  return (
    state.structurallyValid &&
    manifest.publicationId !== undefined &&
    manifest.publicationActionId !== undefined &&
    manifest.acceptanceActionId !== undefined &&
    manifest.controlledRevisionId !== undefined &&
    manifest.controlledContentVersionId !== undefined &&
    manifest.compiledViewId !== undefined &&
    manifest.compiledViewDigest !== undefined &&
    manifest.compiledViewMediaType !== undefined &&
    manifest.publicationTargetId !== undefined &&
    manifest.publicationTargetPolicyDigest !== undefined &&
    manifest.filesAreArray
  );
}
