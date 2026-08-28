import { runIngestCommand, usage } from './ingest/cli.js';

const command = process.argv[2];
if (command !== 'ingest') {
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 2;
} else {
  process.exitCode = await runIngestCommand(process.argv.slice(3));
}
