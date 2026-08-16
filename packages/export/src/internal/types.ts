import type { KeyObject } from 'node:crypto';

export interface ExportFile {
  /** Path relative to the export root. */
  readonly path: string;
  readonly content: string;
}

export interface ExportPackage {
  readonly files: readonly ExportFile[];
  readonly manifest: ExportManifest;
}

export interface ExportManifest {
  readonly format_version: string;
  readonly ontology_version: string;
  readonly ontology_digest: string;
  readonly schema_version: string;
  /** Range of audit sequence numbers this export covers. */
  readonly audit_from_seq: string | number | null;
  readonly audit_to_seq: string | number | null;
  /** Exact digest of ontology plus every authoritative database section in this snapshot. */
  readonly database_snapshot_sha256?: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly files: readonly { path: string; size_bytes: number; sha256: string }[];
}

export interface ExportManifestSignature {
  readonly format_version: 'kf-preservation-manifest-signature-v1';
  readonly algorithm: 'Ed25519';
  readonly key_id: string;
  readonly manifest_sha256: string;
  readonly signature_base64: string;
}

export interface ExportManifestSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

interface ExportTrustOptions {
  /** Historical public keys, indexed by the immutable key id recorded in the sidecar. */
  readonly trustedManifestKeys?: ReadonlyMap<string, KeyObject>;
}

/**
 * The legacy escape hatch is deliberately a discriminated type: accepting unsigned v1 is
 * impossible to express without also naming where its trust warning goes.
 */
export type ExportVerificationOptions = ExportTrustOptions &
  (
    | {
        readonly allowUnsignedLegacyV1: true;
        readonly onWarning: (warning: string) => void;
      }
    | {
        readonly allowUnsignedLegacyV1?: false;
        readonly onWarning?: (warning: string) => void;
      }
  );

export interface SignExportOptions {
  /** Optional historical checkpoint public keys to authenticate and carry with the package. */
  readonly authenticatedFiles?: readonly ExportFile[];
}

export interface CreateExportOptions {
  /** Snapshot exported by a still-open PostgreSQL transaction. Never an arbitrary SQL token. */
  readonly strictSnapshotToken?: string;
}

/** The export format's own version, independent of the ontology's. */
export const EXPORT_FORMAT_VERSION = '2';
export const EXPORT_MANIFEST_SIGNATURE_PATH = 'manifest.signature.json';
export const LEGACY_UNSIGNED_EXPORT_WARNING =
  'UNSIGNED LEGACY EXPORT: format v1 has no authenticated origin; integrity hashes alone ' +
  'do not establish who produced it. Proceeding only because explicit legacy opt-in was given.';

export interface VerificationFinding {
  readonly path: string;
  readonly problem:
    | 'missing'
    | 'size_mismatch'
    | 'digest_mismatch'
    | 'unlisted'
    | 'duplicate'
    | 'manifest_mismatch'
    | 'missing_signature'
    | 'malformed_signature'
    | 'untrusted_key'
    | 'signature_invalid'
    | 'unsupported_format'
    | 'unsigned_legacy';
  readonly detail: string;
}
