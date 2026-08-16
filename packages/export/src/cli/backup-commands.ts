import { createPublicKey } from 'node:crypto';
import { join } from 'node:path';
import { signBackupDirectory, verifyBackupDirectory } from '../backup-manifest.js';
import { verifyExport } from '../index.js';
import type { CliArguments } from './arguments.js';
import { configured, required, signingKey, verificationOptions } from './configuration.js';
import { loadTrustStore, readPackage } from './package-io.js';

export function verifyPackageCommand(args: CliArguments, dir: string): number {
  if (args.snapshotToken !== undefined || args.stageDirectory !== undefined) {
    throw new Error('verify does not accept backup snapshot/staging options');
  }
  const pkg = readPackage(dir);
  const findings = verifyExport(pkg, verificationOptions(pkg, args));
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.problem}: ${finding.path} — ${finding.detail}`);
    }
    return 1;
  }
  console.warn(`ok: ${dir} matches its manifest`);
  return 0;
}

export function signBackupCommand(args: CliArguments, dir: string): number {
  if (
    args.allowUnsignedLegacyV1 ||
    args.checkpointPublicKeyDir !== undefined ||
    args.snapshotToken !== undefined ||
    args.stageDirectory !== undefined
  ) {
    throw new Error('sign-backup accepts signing and trust-store options only');
  }
  const trustStoreDir = required(
    configured(args.trustStoreDir, 'PRESERVATION_TRUST_STORE_DIR'),
    'sign-backup requires --trust-store or PRESERVATION_TRUST_STORE_DIR',
  );
  const trustedKeys = loadTrustStore(trustStoreDir);
  const innerPackage = readPackage(join(dir, 'export'));
  const innerFindings = verifyExport(innerPackage, {
    trustedManifestKeys: trustedKeys,
  });
  if (innerFindings.length > 0) {
    throw new Error(
      `refusing to sign backup with unauthenticated inner export: ${innerFindings
        .map((finding) => `${finding.problem}:${finding.path}`)
        .join(', ')}`,
    );
  }
  const key = signingKey(args);
  const trustedSigningKey = trustedKeys.get(key.keyId);
  if (
    trustedSigningKey === undefined ||
    !trustedSigningKey.equals(createPublicKey(key.privateKey))
  ) {
    throw new Error(`backup signing key ${key.keyId} is absent or mismatched in trust store`);
  }
  const manifest = signBackupDirectory(dir, key);
  console.warn(JSON.stringify({ signed_backup: dir, files: manifest.files.length }));
  return 0;
}

export function verifyBackupCommand(args: CliArguments, dir: string): number {
  if (
    args.allowUnsignedLegacyV1 ||
    args.signingKeyPath !== undefined ||
    args.signingKeyId !== undefined ||
    args.checkpointPublicKeyDir !== undefined ||
    args.snapshotToken !== undefined
  ) {
    throw new Error('verify-backup accepts only --trust-store and optional --stage');
  }
  const trustStoreDir = required(
    configured(args.trustStoreDir, 'PRESERVATION_TRUST_STORE_DIR'),
    'verify-backup requires --trust-store or PRESERVATION_TRUST_STORE_DIR',
  );
  const manifest = verifyBackupDirectory(
    dir,
    loadTrustStore(trustStoreDir),
    args.stageDirectory === undefined ? {} : { stageDirectory: args.stageDirectory },
  );
  console.warn(JSON.stringify({ verified_backup: dir, files: manifest.files.length }));
  return 0;
}
