const STRICT_SNAPSHOT_TOKEN = /^[0-9A-F]{8}-[0-9A-F]{8}-[0-9]+$/;

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
}

export function usage(): string {
  return [
    'usage:',
    '  kf-export write <directory> --signing-key <private.pem> --key-id <id>',
    '      [--checkpoint-public-key-dir <directory>] [--snapshot <exported-snapshot-token>]',
    '  kf-export verify <directory> --trust-store <public-key-directory>',
    '      [--allow-unsigned-legacy-v1]',
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
  return {
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
