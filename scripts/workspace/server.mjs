#!/usr/bin/env node
/* global clearTimeout, setInterval, setTimeout */
// The launcher's local page: first-run setup and "Starting Knowledge Fabric…", in the browser.
//
// launcher.mjs (what the desktop icon runs) starts this as the systemd user service kf-local and
// opens its URL. It serves only:
//
//   GET  /<token>/          the setup form when no workspace exists, else the progress page
//   POST /<token>/setup     organization, name, username, password twice, optional folder (JSON)
//   GET  /<token>/progress  where the start is, as JSON; the page polls it and opens Home when ready
//
// and refuses everything else. Three guards keep it the person's own:
//
//   loopback   it listens on 127.0.0.1 only, never a wildcard address
//   token      32 random bytes in the path, made at start and written only to a 0600 file
//              (~/.local/state/kf-local-launcher/url); a request without it is a 404, so another
//              local user or a web page cannot drive it
//   host       the Host header must be this server's own 127.0.0.1:<port> (a DNS-rebinding page
//              names another host), and a POST must come from this origin as JSON
//
// One instance: a lock file naming this process by pid and start time (lock.mjs); a second copy
// exits at once and the launcher opens the first one's page.
//
// The password typed into the form is held in memory for the one start that creates the account
// (Keycloak's reset-password request body) and signs in to add the folder's files; it is never
// logged, written or echoed back. Nothing here logs a request body.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupPage, progressPage } from './pages.mjs';
import {
  PORTS,
  WorkspaceError,
  passwordProblems,
  validateIdentity,
  workspacePaths,
} from './plan.mjs';

// Ready means: straight to the sign-in, which returns to Home (an existing session passes through).
const HOME_URL = `http://localhost:${PORTS.web}/auth/login?next=%2F`;
const BODY_LIMIT = 16 * 1024;

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

const json = (res, status, value) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));

function sameToken(given, token) {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A plain-language failure for the page; the detail goes to the journal, never to the page. */
function failureOf(error, log) {
  if (error instanceof WorkspaceError) return { message: error.message, advice: error.advice };
  log(`!! unexpected failure: ${error?.stack ?? error}`);
  return {
    message: 'Something went wrong while starting Knowledge Fabric.',
    advice:
      'Close this page and click Knowledge Fabric again. If it happens again, the details are ' +
      'in the system log (journalctl --user -u kf-local).',
  };
}

/**
 * The server, not yet listening. `mode`: 'setup' (no workspace: the form first) or 'start' (start
 * the existing one at once). `start(request, { step })` is the engine's startWorkspace.
 */
export function createLauncherServer({ token, mode, start, log = () => {}, homeUrl = HOME_URL }) {
  const progress = { state: 'idle', steps: [], error: undefined, imported: undefined };
  let port;

  const step = (id, label) => {
    const last = progress.steps.at(-1);
    if (last?.id === id) last.label = label;
    else progress.steps.push({ id, label });
  };

  const begin = (request) => {
    progress.state = 'running';
    progress.steps = [];
    progress.error = undefined;
    log('== starting the workspace');
    start(request, { step, log }).then(
      (result) => {
        progress.imported = result?.imported;
        progress.state = 'ready';
        log('== ready');
      },
      (error) => {
        progress.error = failureOf(error, log);
        progress.state = 'failed';
        log(`== failed: ${progress.error.message}`);
      },
    );
  };

  const server = createServer(async (req, res) => {
    try {
      const expectedHost = `127.0.0.1:${port}`;
      if (req.headers.host !== expectedHost) return send(res, 421, 'text/plain', 'wrong host\n');
      const url = new URL(req.url ?? '/', `http://${expectedHost}`);
      const [, given, ...rest] = url.pathname.split('/');
      if (given === undefined || !sameToken(given, token)) {
        return send(res, 404, 'text/plain', 'not found\n');
      }
      const route = rest.join('/');
      if (req.method === 'GET' && route === '') {
        // After a failed setup the form comes back, so "Try again" is just reloading the page.
        const page =
          mode === 'setup' && (progress.state === 'idle' || progress.state === 'failed')
            ? setupPage()
            : progressPage({ mode });
        return send(res, 200, 'text/html; charset=utf-8', page);
      }
      if (req.method === 'GET' && route === 'progress') {
        return json(res, 200, { ...progress, home: homeUrl });
      }
      if (req.method === 'POST') {
        if (req.headers.origin !== `http://${expectedHost}`) {
          return send(res, 403, 'text/plain', 'wrong origin\n');
        }
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return send(res, 415, 'text/plain', 'json only\n');
        }
      }
      if (req.method === 'POST' && route === 'retry') {
        if (mode !== 'start' || progress.state !== 'failed') return json(res, 409, {});
        begin({});
        return json(res, 202, { ok: true });
      }
      if (req.method === 'POST' && route === 'setup') {
        if (mode !== 'setup' || progress.state === 'running' || progress.state === 'ready') {
          return json(res, 409, { problems: ['Knowledge Fabric is already being set up.'] });
        }
        let form;
        try {
          form = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { problems: ['The form could not be read; please try again.'] });
        }
        let identity;
        const problems = [];
        try {
          identity = validateIdentity({
            organization: form.organization,
            name: form.name,
            username: typeof form.username === 'string' ? form.username.toLowerCase() : '',
          });
        } catch (error) {
          problems.push(...String(error.message).split('; '));
        }
        problems.push(
          ...passwordProblems(form.password, form.confirm, identity ?? { username: form.username }),
        );
        const folder = typeof form.folder === 'string' ? form.folder.trim() : '';
        if (folder !== '') {
          let isDir = false;
          try {
            isDir = statSync(folder).isDirectory();
          } catch {
            isDir = false;
          }
          if (!isDir) problems.push(`There is no folder at ${folder}.`);
        }
        if (problems.length > 0) return json(res, 400, { problems });
        begin({
          ...identity,
          password: form.password,
          ...(folder === '' ? {} : { importFolder: folder }),
        });
        return json(res, 202, { ok: true });
      }
      return send(res, 404, 'text/plain', 'not found\n');
    } catch {
      return send(res, 500, 'text/plain', 'error\n');
    }
  });

  return {
    server,
    progress,
    /** Listen on 127.0.0.1 only; resolves with this server's URL (token included). */
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          if (mode === 'start') begin({});
          resolve(`http://127.0.0.1:${port}/${token}/`);
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function main() {
  const { acquireLock } = await import('./lock.mjs');
  const engine = await import('./engine.mjs');
  const paths = workspacePaths();
  await mkdir(paths.launcher, { recursive: true, mode: 0o700 });
  const urlFile = path.join(paths.launcher, 'url');
  const lock = acquireLock(path.join(paths.launcher, 'server.lock'));
  if (!lock.acquired) {
    process.stdout.write(`another launcher server runs (pid ${lock.holder.pid}); exiting\n`);
    return;
  }
  const log = (line) => process.stdout.write(`${line}\n`);
  const mode = (await engine.workspaceExists()) ? 'start' : 'setup';
  const token = randomBytes(32).toString('base64url');
  let closer;
  // Setup waits for the person as long as it takes; once a start has finished, the page stays
  // for ten minutes (time to read a failure, retry, or follow the switch to Home), then closes.
  const arm = () => {
    clearTimeout(closer);
    closer = setTimeout(() => void closeIfIdle(), 10 * 60_000);
  };
  const app = createLauncherServer({
    token,
    mode,
    log,
    start: async (request, { step }) => {
      try {
        return await engine.startWorkspace(request, { step, log });
      } finally {
        arm();
      }
    },
  });
  const url = await app.listen();
  await writeFile(urlFile, `${url}\n`, { mode: 0o600 });
  log(`== launcher page ready (${mode}); its address is in ${urlFile}`);

  const shutdown = async () => {
    await rm(urlFile, { force: true });
    lock.release();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  async function closeIfIdle() {
    if (app.progress.state === 'running') return;
    await app.close();
    await rm(urlFile, { force: true });
    if (app.progress.state !== 'ready') {
      lock.release();
      process.exit(1);
    }
    // Ready: the applications this service started live in its control group, so it stays
    // (doing nothing) until `pnpm kf:stop`, a reset or logging out stops it.
    log('== launcher page closed; Knowledge Fabric keeps running');
  }
  setInterval(() => {}, 1 << 30);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
