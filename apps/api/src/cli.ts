import { runIngestCommand, usage } from './ingest/cli.js';
import { findRoot, overviewUsage, runOverviewCommand } from './overview/cli.js';

const command = process.argv[2];
const rest = process.argv.slice(3);

if (command === 'ingest') {
  process.exitCode = await runIngestCommand(rest);
} else if (command === 'overview') {
  try {
    const root = findRoot(process.cwd());
    process.exitCode = runOverviewCommand(rest, root, process.stdout, process.stderr);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
} else {
  process.stderr.write(`${usage()}\n\n${overviewUsage()}\n`);
  process.exitCode = 2;
}
