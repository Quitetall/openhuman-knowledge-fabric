import { readFileSync } from 'node:fs';
import { runOffsiteCli } from './internal/offsite/cli.js';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
try {
  // This Linux preservation entry point refuses credential handling while core dumps are enabled.
  if (
    process.platform !== 'linux' ||
    !/^Max core file size\s+0\s/m.test(readFileSync('/proc/self/limits', 'utf8'))
  )
    throw new Error();
  await runOffsiteCli(process.argv.slice(2), process.stdin, process.stdout, abort.signal);
} catch {
  console.error('kf-offsite: ciphertext transfer refused');
  process.exitCode = 1;
}
