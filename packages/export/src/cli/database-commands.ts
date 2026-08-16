import { createPublicKey } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createPool, withTransaction } from '@kf/database';
import { createExport, importExport, signExportPackage, verifyExport } from '../index.js';
import type { CliArguments } from './arguments.js';
import {
  configured,
  requireDatabaseUrl,
  signingKey,
  verificationOptions,
} from './configuration.js';
import { checkpointPublicKeys, readPackage, writePackage } from './package-io.js';

type DatabasePool = ReturnType<typeof createPool>;

async function writeExport(pool: DatabasePool, args: CliArguments, dir: string): Promise<number> {
  if (
    args.allowUnsignedLegacyV1 ||
    args.trustStoreDir !== undefined ||
    args.stageDirectory !== undefined
  ) {
    throw new Error('write accepts signing options, not verify/load compatibility options');
  }
  const { keyId, privateKey } = signingKey(args);
  const archivedCheckpointKeys = checkpointPublicKeys(
    configured(args.checkpointPublicKeyDir, 'CHECKPOINT_PUBLIC_KEY_DIR'),
  );
  const exportOptions =
    args.snapshotToken === undefined ? {} : { strictSnapshotToken: args.snapshotToken };
  const unsigned = await withTransaction(pool, async (tx) => createExport(tx, exportOptions));
  const pkg = signExportPackage(
    unsigned,
    { keyId, privateKey },
    { authenticatedFiles: archivedCheckpointKeys },
  );
  mkdirSync(dir, { recursive: true });
  writePackage(dir, pkg);
  // Re-read from disk and verify, rather than trusting what was just in memory. An
  // export that was corrupted on the way to the filesystem is exactly the failure this
  // whole format exists to survive.
  const findings = verifyExport(readPackage(dir), {
    trustedManifestKeys: new Map([[keyId, createPublicKey(privateKey)]]),
  });
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.problem}: ${finding.path} — ${finding.detail}`);
    }
    return 1;
  }
  console.warn(
    JSON.stringify({
      wrote: dir,
      files: pkg.files.length,
      counts: pkg.manifest.counts,
      audit_range: [pkg.manifest.audit_from_seq, pkg.manifest.audit_to_seq],
    }),
  );
  return 0;
}

async function loadExport(pool: DatabasePool, args: CliArguments, dir: string): Promise<number> {
  if (args.snapshotToken !== undefined || args.stageDirectory !== undefined) {
    throw new Error('load does not accept backup snapshot/staging options');
  }
  const pkg = readPackage(dir);
  const result = await withTransaction(pool, async (tx) =>
    importExport(tx, pkg, verificationOptions(pkg, args)),
  );
  console.warn(JSON.stringify({ loaded: dir, rows: result.imported }));
  return 0;
}

export async function runDatabaseCommand(args: CliArguments, dir: string): Promise<number> {
  const pool = createPool({ connectionString: requireDatabaseUrl(), maxConnections: 2 });
  try {
    if (args.verb === 'write') return writeExport(pool, args, dir);
    if (args.verb === 'load') return loadExport(pool, args, dir);

    console.error(`unknown verb: ${args.verb}`);
    return 2;
  } finally {
    await pool.end();
  }
}
