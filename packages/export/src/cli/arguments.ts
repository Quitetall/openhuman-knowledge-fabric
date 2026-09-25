// One definition, shared with the library that interpolates this value into SQL. A private
// copy here is how the two drifted apart in the first place.
import { STRICT_SNAPSHOT_TOKEN } from '../internal/format.js';

export interface CliArguments {
  readonly verb: string | undefined;
  readonly dir: string | undefined;
  readonly signingKeyPath: string | undefined;
  readonly signingKeyId: string | undefined;
  readonly trustStoreDir: string | undefined;
  readonly checkpointPublicKeyDir: string | undefined;
  readonly snapshotToken: string | undefined;
  readonly stageDirectory: string | undefined;
  readonly allowUnsignedLegacyV1: boolean;
  readonly warrantId: string | undefined;
  readonly archiveBasisFile: string | undefined;
  readonly dispatchFiles: readonly string[];
}

export function usage(): string {
  return [
    'usage:',
    '  kf-export write <directory> --signing-key <private.pem> --key-id <id>',
    '      [--checkpoint-public-key-dir <directory>] [--snapshot <exported-snapshot-token>]',
    '  kf-export verify <directory> --trust-store <public-key-directory>',
    '      [--allow-unsigned-legacy-v1]',
    '  kf-export runtime-evidence <directory> --trust-store <public-key-directory>',
    '      --warrant-id <uuid> [--dispatch-file <packet.json> ...] [--archive-basis <basis.json>]',
    '  kf-export load <directory> --trust-store <public-key-directory>',
    '      [--allow-unsigned-legacy-v1]',
    '  kf-export sign-backup <directory> --signing-key <private.pem> --key-id <id>',
    '      --trust-store <public-key-directory>',
    '  kf-export verify-backup <directory> --trust-store <public-key-directory>',
    '      [--stage <new-private-directory>]',
  ].join('\n');
}

export function parseArguments(argv: readonly string[]): CliArguments {
  const positional: string[] = [];
  let signingKeyPath: string | undefined;
  let signingKeyId: string | undefined;
  let trustStoreDir: string | undefined;
  let checkpointPublicKeyDir: string | undefined;
  let snapshotToken: string | undefined;
  let stageDirectory: string | undefined;
  let allowUnsignedLegacyV1 = false;
  let warrantId: string | undefined;
  let archiveBasisFile: string | undefined;
  const dispatchFiles: string[] = [];

  const valueAfter = (index: number, option: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--allow-unsigned-legacy-v1') {
      allowUnsignedLegacyV1 = true;
    } else if (argument === '--signing-key') {
      signingKeyPath = valueAfter(index, argument);
      index += 1;
    } else if (argument === '--key-id') {
      signingKeyId = valueAfter(index, argument);
      index += 1;
    } else if (argument === '--trust-store') {
      trustStoreDir = valueAfter(index, argument);
      index += 1;
    } else if (argument === '--checkpoint-public-key-dir') {
      checkpointPublicKeyDir = valueAfter(index, argument);
      index += 1;
    } else if (argument === '--snapshot') {
      snapshotToken = valueAfter(index, argument);
      index += 1;
    } else if (argument === '--stage') {
      stageDirectory = valueAfter(index, argument);
      index += 1;
    } else if (argument === '--warrant-id') {
      if (warrantId !== undefined) throw new Error('--warrant-id may appear only once');
      warrantId = valueAfter(index, argument);
      index += 1;
    } else if (argument === '--archive-basis') {
      if (archiveBasisFile !== undefined) throw new Error('--archive-basis may appear only once');
      archiveBasisFile = valueAfter(index, argument);
      index += 1;
    } else if (argument === '--dispatch-file') {
      dispatchFiles.push(valueAfter(index, argument));
      if (dispatchFiles.length > 256) throw new Error('at most 256 dispatch files are allowed');
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length > 2) throw new Error(`unexpected argument: ${positional[2]}`);
  if (snapshotToken !== undefined && !STRICT_SNAPSHOT_TOKEN.test(snapshotToken)) {
    throw new Error('--snapshot must be an exact PostgreSQL exported snapshot token');
  }
  if (
    positional[0] !== 'runtime-evidence' &&
    (warrantId !== undefined || dispatchFiles.length > 0 || archiveBasisFile !== undefined)
  ) {
    throw new Error('runtime evidence options require runtime-evidence');
  }
  return {
    warrantId,
    archiveBasisFile,
    dispatchFiles,
    verb: positional[0],
    dir: positional[1],
    signingKeyPath,
    signingKeyId,
    trustStoreDir,
    checkpointPublicKeyDir,
    snapshotToken,
    stageDirectory,
    allowUnsignedLegacyV1,
  };
}
