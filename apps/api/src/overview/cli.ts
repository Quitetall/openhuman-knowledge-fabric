/**
 * `kf overview` — regenerate the control record.
 *
 * One command, because a document that takes a procedure to refresh is a document that goes
 * stale. ADR 0024 made speed of use an architectural requirement of this system; a status page
 * nobody can regenerate in one step is the same defect one layer up from the ones that ADR is
 * about.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { collectOverview } from './collect.js';
import { renderOverview } from './render.js';

export const DEFAULT_OUT = 'docs/generated/overview.html';

export function overviewUsage(): string {
  return [
    'kf overview — regenerate the Knowledge Fabric control record',
    '',
    '  kf overview                 write docs/generated/overview.html',
    '  kf overview --out <path>    write somewhere else',
    '  kf overview --check         exit non-zero if the committed page is stale',
    '',
    'Reads the specification and the Warrant corpus. Touches no database and no host: a',
    'projection that reads live state cannot be regenerated from a clone and compared, and',
    'comparison is what makes drift detectable.',
  ].join('\n');
}

export interface OverviewArgs {
  readonly out: string;
  readonly check: boolean;
}

export function parseOverviewArgs(argv: readonly string[]): OverviewArgs {
  let out = DEFAULT_OUT;
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--check') {
      check = true;
      continue;
    }
    const inline = /^--out=(.+)$/.exec(arg);
    if (inline !== null) {
      out = inline[1]!;
      continue;
    }
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--out needs a path');
      }
      out = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  return { out, check };
}

export function runOverviewCommand(
  argv: readonly string[],
  root: string,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): number {
  let args: OverviewArgs;
  try {
    args = parseOverviewArgs(argv);
  } catch (error: unknown) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    stderr.write(`${overviewUsage()}\n`);
    return 2;
  }

  const html = renderOverview(collectOverview(root));
  const path = resolve(root, args.out);

  if (args.check) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current === html) {
      stdout.write(`${args.out} is current\n`);
      return 0;
    }
    stderr.write(
      `${args.out} is stale. Run \`kf overview\` and commit the result.\n` +
        'It is generated from the specification and the Warrant corpus, so a difference means\n' +
        'one of those moved and the page did not.\n',
    );
    return 1;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
  stdout.write(`wrote ${args.out}\n`);
  return 0;
}
