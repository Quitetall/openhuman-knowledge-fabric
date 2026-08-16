import { createPrivateKey, type KeyObject } from 'node:crypto';
import { loadSecret, readSecretFile } from '@kf/operations';
import type { ExportPackage, ExportVerificationOptions } from '../index.js';
import type { CliArguments } from './arguments.js';
import { loadTrustStore } from './package-io.js';

export function configured(
  argument: string | undefined,
  environmentName: string,
): string | undefined {
  return argument ?? process.env[environmentName];
}

export function required(value: string | undefined, message: string): string {
  if (value === undefined || value === '') throw new Error(message);
  return value;
}

export function signingKey(args: CliArguments): {
  readonly keyId: string;
  readonly privateKey: KeyObject;
} {
  const signingKeyPath = required(
    configured(args.signingKeyPath, 'PRESERVATION_SIGNING_KEY_PATH'),
    `${args.verb ?? 'command'} requires --signing-key or PRESERVATION_SIGNING_KEY_PATH`,
  );
  const keyId = required(
    configured(args.signingKeyId, 'PRESERVATION_SIGNING_KEY_ID'),
    `${args.verb ?? 'command'} requires --key-id or PRESERVATION_SIGNING_KEY_ID`,
  );
  return {
    keyId,
    privateKey: createPrivateKey(readSecretFile(signingKeyPath, 'PRESERVATION_SIGNING_KEY_PATH')),
  };
}

export function requireDatabaseUrl(): string {
  return loadSecret('DATABASE_URL', process.env, {
    allowInline: process.env['NODE_ENV'] !== 'production',
  });
}

export function verificationOptions(
  pkg: ExportPackage,
  args: CliArguments,
): ExportVerificationOptions {
  const allowUnsignedLegacyV1 = args.allowUnsignedLegacyV1;
  const onWarning = (warning: string): void => console.error(`WARNING: ${warning}`);
  const legacyOptions = allowUnsignedLegacyV1
    ? ({ allowUnsignedLegacyV1: true, onWarning } as const)
    : ({ allowUnsignedLegacyV1: false, onWarning } as const);
  if (pkg.manifest.format_version === '1') {
    return legacyOptions;
  }
  const trustStoreDir = required(
    configured(args.trustStoreDir, 'PRESERVATION_TRUST_STORE_DIR'),
    'format v2 verify/load requires --trust-store or PRESERVATION_TRUST_STORE_DIR',
  );
  return {
    trustedManifestKeys: loadTrustStore(trustStoreDir),
    ...legacyOptions,
  };
}
