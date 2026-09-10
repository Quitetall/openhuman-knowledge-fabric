import { runIngestCommand, usage } from './ingest/cli.js';
import { overviewUsage, runOverviewCommand } from './overview/cli.js';

const command = process.argv[2];
const rest = process.argv.slice(3);

if (command === 'ingest') {
  process.exitCode = await runIngestCommand(rest);
} else if (command === 'overview') {
  process.exitCode = runOverviewCommand(rest, process.cwd(), process.stdout, process.stderr);
} else {
  process.stderr.write(`${usage()}\n\n${overviewUsage()}\n`);
  process.exitCode = 2;
}
