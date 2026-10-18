#!/usr/bin/env node
/* global setTimeout */
// What the "Knowledge Fabric" icon runs (the .desktop entry install-launcher.mjs writes).
//
//   running      open the browser on Home
//   not running  start the launcher's page as the systemd user service kf-local (detached, so it
//                outlives the click, and logged to the journal: journalctl --user -u kf-local),
//                then open that page: setup on the first run, "Starting Knowledge Fabric…" after
//
// Clicking twice never starts two: a second `systemd-run --unit=kf-local` is refused while the
// first exists, and the page's own lock (server.mjs) refuses a second server even without
// systemd. Either way the second click opens the page the first one started.
//
// Builtins and this directory's modules only: it must work before anything is built.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIT, runCommand, workspaceAnswering } from './engine.mjs';
import { lockHolder } from './lock.mjs';
import { PORTS, workspacePaths } from './plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export const CONFIG = path.join(homedir(), '.local', 'share', 'knowledge-fabric', 'launcher.json');

/** Open `url` in the person's browser, detached. KF_LAUNCHER_BROWSER names another opener. */
function open(url) {
  const opener =
    process.env.KF_LAUNCHER_BROWSER ?? (process.platform === 'darwin' ? 'open' : 'xdg-open');
  const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

function config() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

async function liveUrl(paths) {
  if (lockHolder(path.join(paths.launcher, 'server.lock')) === undefined) return undefined;
  try {
    return (await readFile(path.join(paths.launcher, 'url'), 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function waitForUrl(paths, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const url = await liveUrl(paths);
    if (url !== undefined) return url;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

/** Start server.mjs as the user service, or detached when there is no systemd user manager. */
async function startServer(settings) {
  const server = path.join(HERE, 'server.mjs');
  const node = settings.node ?? process.execPath;
  const envPath = settings.path ?? process.env.PATH ?? '/usr/bin:/bin';
  const unit = await runCommand(
    'systemd-run',
    [
      '--user',
      `--unit=${UNIT}`,
      '--description=Knowledge Fabric',
      '--collect',
      '--quiet',
      `--working-directory=${REPO}`,
      `--setenv=PATH=${envPath}`,
      node,
      server,
    ],
    { timeoutMs: 30_000 },
  );
  if (unit.code === 127) {
    const child = spawn(node, [server], {
      cwd: REPO,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: envPath },
    });
    child.unref();
  }
  // Any other failure is most often "already exists": a click a moment ago started it.
  return unit;
}

async function failurePage(paths, message, advice) {
  await mkdir(paths.launcher, { recursive: true, mode: 0o700 });
  const file = path.join(paths.launcher, 'problem.html');
  const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  await writeFile(
    file,
    `<!doctype html><meta charset="utf-8"><title>Knowledge Fabric</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:8vh auto;padding:0 16px">
<h1>Knowledge Fabric did not start</h1><p><strong>${esc(message)}</strong></p><p>${esc(advice)}</p>`,
    { mode: 0o600 },
  );
  open(`file://${file}`);
}

async function main() {
  const paths = workspacePaths();
  if (await workspaceAnswering()) {
    open(`http://localhost:${PORTS.web}/`);
    return 0;
  }
  let url = await liveUrl(paths);
  if (url === undefined) {
    const holder = lockHolder(path.join(paths.launcher, 'server.lock'));
    if (holder === undefined) {
      await startServer(config());
      url = await waitForUrl(paths, 30);
    } else {
      // The service runs but its page has closed and Knowledge Fabric is not answering (its
      // applications stopped): start it over, which resumes the workspace.
      url = await waitForUrl(paths, 5);
      if (url === undefined) {
        await runCommand('systemctl', ['--user', 'restart', UNIT], { timeoutMs: 60_000 });
        url = await waitForUrl(paths, 30);
      }
    }
  }
  if (url === undefined) {
    await failurePage(
      paths,
      'Knowledge Fabric could not start its helper.',
      existsSync(CONFIG)
        ? 'Restart the computer and click Knowledge Fabric again.'
        : 'It does not look installed: run the one-time install step again (pnpm kf:install-launcher).',
    );
    return 1;
  }
  open(url);
  return 0;
}

process.exitCode = await main();
