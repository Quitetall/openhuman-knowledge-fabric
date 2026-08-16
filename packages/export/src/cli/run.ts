import { parseArguments, usage } from './arguments.js';
import { signBackupCommand, verifyBackupCommand, verifyPackageCommand } from './backup-commands.js';
import { runDatabaseCommand } from './database-commands.js';

export async function runCli(argv: readonly string[]): Promise<number> {
  let args;
  try {
    args = parseArguments(argv);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    return 2;
  }
  const { verb, dir } = args;
  if (verb === undefined || dir === undefined) {
    console.error(usage());
    return 2;
  }

  if (verb === 'verify') return verifyPackageCommand(args, dir);
  if (verb === 'sign-backup') return signBackupCommand(args, dir);
  if (verb === 'verify-backup') return verifyBackupCommand(args, dir);
  return runDatabaseCommand(args, dir);
}
