/** Authenticated root manifest for one operational backup directory. */

export {
  BACKUP_MANIFEST_FORMAT,
  BACKUP_MANIFEST_PATH,
  BACKUP_MANIFEST_SIGNATURE_FORMAT,
  BACKUP_MANIFEST_SIGNATURE_PATH,
} from './backup-manifest/types.js';
export type {
  BackupManifest,
  BackupManifestFile,
  BackupManifestSignature,
  BackupManifestSigningKey,
  VerifyBackupOptions,
} from './backup-manifest/types.js';
export { backupManifestSigningBytes } from './backup-manifest/format.js';
export { signBackupDirectory, verifyBackupDirectory } from './backup-manifest/operations.js';
