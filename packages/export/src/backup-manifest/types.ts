import type { KeyObject } from 'node:crypto';

export const BACKUP_MANIFEST_PATH = 'backup.manifest.json';
export const BACKUP_MANIFEST_SIGNATURE_PATH = 'backup.manifest.signature.json';
export const BACKUP_MANIFEST_FORMAT = 'kf-backup-manifest-v1';
export const BACKUP_MANIFEST_SIGNATURE_FORMAT = 'kf-backup-manifest-signature-v1';

export interface BackupManifestFile {
  readonly path: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

export interface BackupManifest {
  readonly format_version: typeof BACKUP_MANIFEST_FORMAT;
  /** Semantic identity of authoritative database rows carried by authenticated inner export. */
  readonly database_snapshot_sha256: string;
  readonly files: readonly BackupManifestFile[];
}

export interface BackupManifestSignature {
  readonly format_version: typeof BACKUP_MANIFEST_SIGNATURE_FORMAT;
  readonly algorithm: 'Ed25519';
  readonly key_id: string;
  readonly manifest_sha256: string;
  readonly signature_base64: string;
}

export interface BackupManifestSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
}

export interface VerifyBackupOptions {
  /** New private directory populated with the exact bytes checked against signed digests. */
  readonly stageDirectory?: string;
}
