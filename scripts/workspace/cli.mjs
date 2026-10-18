#!/usr/bin/env node
// The command-line face of the workspace engine, for scripted use:
//
//   pnpm kf:start -- --organization "Acme Engineering" --name "Ada Lovelace" --username ada \
//                    [--email ada@example.com] [--import <folder>]
//   pnpm kf:stop | pnpm kf:status | pnpm kf:reset -- --yes
//
// Most people never type this: the desktop launcher (pnpm kf:install-launcher, then click
// "Knowledge Fabric") drives the same engine from a page in the browser. A fresh checkout needs
// its dependencies first, so this file imports nothing outside Node until `pnpm install` has run.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A password typed at a terminal, not echoed; only when stdin is one. */
function askPassword(username) {
  if (!process.stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    process.stderr.write(`Password for ${username} (not shown): `);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let typed = '';
    const done = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(typed);
        if (ch === '\u0003') return done(undefined);
        if (ch === '\u007f') typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(argv) {
  if (!existsSync(path.join(REPO, 'node_modules', '.modules.yaml'))) {
    process.stdout.write(
      '== first run: installing dependencies (pnpm install --frozen-lockfile)\n',
    );
    const installed = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
      cwd: REPO,
      stdio: 'inherit',
      timeout: 20 * 60_000,
    });
    if (installed.status !== 0) {
      process.stderr.write('pnpm install failed; see above\n');
      return 1;
    }
  }
  const { WorkspaceError, nextSteps, parseWorkspaceArgs, usage } = await import('./plan.mjs');
  const engine = await import('./engine.mjs');
  try {
    const { command, options } = parseWorkspaceArgs(argv);
    if (command === 'help') {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (command === 'stop') await engine.stopWorkspace();
    else if (command === 'status') await engine.statusWorkspace();
    else if (command === 'reset') await engine.resetWorkspace({ yes: options.yes === true });
    else {
      const { importSummary } = options.import === undefined ? {} : await import('./bootstrap.mjs');
      const result = await engine.startWorkspace(
        {
          organization: options.organization,
          name: options.name,
          username: options.username,
          email: options.email,
          ...(options.import === undefined ? {} : { importFolder: options.import }),
        },
        { askPassword },
      );
      process.stdout.write(
        nextSteps({
          identity: result.identity,
          passwordFile: result.record.passwordFile,
          semantic: result.semantic,
          imported: result.imported === undefined ? undefined : importSummary(result.imported),
        }),
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof WorkspaceError) {
      process.stderr.write(`\n${error.message}\n${error.advice ? `${error.advice}\n` : ''}`);
      return error.code === 'usage' || error.code === 'needs_yes' ? 2 : 1;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
