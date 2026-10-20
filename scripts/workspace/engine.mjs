/* global AbortSignal, clearTimeout, fetch, setTimeout */
// The workspace engine: start, stop, status and reset of one's own Knowledge Fabric.
//
// Both faces drive this: the command line (cli.mjs, `pnpm kf:start`) and the desktop launcher's
// local page (server.mjs). Every effect goes through `deps`, so tests/deployment/workspace.test.ts
// runs a whole start against fakes and can see every argv, environment and line it produced.
//
//   start   check the ports and Docker; pick semantic search when an embedding server another
//           stack runs is answering (nothing is downloaded); run fixtures/veracier/stack/stack.sh
//           `up` the first time and `resume` after; on the first run create the organization, the
//           person, their sign-in and authority (bootstrap.mjs); import a folder if asked
//   stop    stack.sh down (data kept), and the launcher's service if it runs
//   status  what exists and what runs
//   reset   with `yes` only: stack.sh reset, which deletes THIS workspace's volumes and state
//
// A password reaches this module one of two ways and leaves it one way. From the launcher's page,
// typed by the person, in memory; from the command line, generated once into a 0600 file in the
// state directory. Either way it is sent only in Keycloak's reset-password request body and used
// to sign in for an import; it is never printed, logged, put in an argv or an environment, or
// written anywhere else.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from './lock.mjs';
import {
  ON_HOST_MODEL_CANDIDATES,
  agentEnv,
  answersPaths,
  answersProblems,
  answersView,
  ceilingFor,
  isLoopbackModelUrl,
  resolveCloud,
  usesCloud,
  usesOnHost,
} from './answers.mjs';
import {
  EMBED_CANDIDATES,
  PORTS,
  PROJECT,
  WorkspaceError,
  appsRunning,
  decideStart,
  listeningPorts,
  ownedPorts,
  portConflicts,
  portRefusal,
  publishedPorts,
  settingsFor,
  stackEnv,
  workspacePaths,
} from './plan.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STACK = path.join(REPO, 'fixtures', 'veracier', 'stack', 'stack.sh');
export const UNIT = `${PROJECT}.service`;

const MINUTE = 60_000;

/** Run a command with a deadline, streaming its lines to `onLine`. Never throws. */
export function runCommand(command, args, { env = process.env, timeoutMs, onLine, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGTERM');
      },
      timeoutMs ?? 5 * MINUTE,
    );
    const lines = (chunk, sink) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line !== '') sink?.(line);
    };
    child.stdout.on('data', (d) => {
      stdout += d;
      lines(d, onLine);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      lines(d, onLine);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

async function probe(url, timeoutMs = 3000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The models an OpenAI-style server on this computer offers (`GET /v1/models`), or undefined when
 * nothing answers there. This is what the on-host backend speaks (@kf/agent lamu.ts:
 * `POST /v1/chat/completions`); LAMU and Ollama both serve it.
 */
async function listModels(url, timeoutMs = 3000) {
  try {
    const response = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) return { answering: true, models: [] };
    const body = await response.json();
    const models = Array.isArray(body?.data)
      ? body.data.map((m) => m?.id).filter((id) => typeof id === 'string' && id !== '')
      : [];
    return { answering: true, models };
  } catch {
    return undefined;
  }
}

export function defaultDeps(overrides = {}) {
  const home = overrides.home ?? homedir();
  return {
    home,
    env: process.env,
    run: runCommand,
    probe,
    listModels,
    log: (line) => process.stdout.write(`${line}\n`),
    step: () => {},
    loadBootstrap: () => import('./bootstrap.mjs'),
    askPassword: undefined,
    lamuBin: path.join(home, '.local', 'libexec', 'kf-veracier', 'lamu'),
    embedModelDir: path.join(home, '.local', 'share', 'kf-veracier', 'bge-m3-f16'),
    ...overrides,
  };
}

async function readRecord(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeRecord(file, record) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

// ── AI answers ──────────────────────────────────────────────────────────────────────────────────

/**
 * The provider's key, into an owner-only file: created fresh (O_EXCL, 0600, so no earlier file's
 * mode or owner is inherited), then renamed over the old one. The key is in this process's memory
 * and this file, and nowhere else.
 */
export async function writeKeyFile(file, key) {
  const tmp = `${file}.tmp`;
  await rm(tmp, { force: true });
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, `${key}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  await rename(tmp, file);
}

/** A model server on this computer the on-host backend can use: `{ url, models }` or `{ reason }`. */
export async function detectOnHostModel(depsIn = {}) {
  const deps = defaultDeps(depsIn);
  const wanted = deps.env.KF_LOCAL_MODEL_URL;
  if (wanted !== undefined && !isLoopbackModelUrl(wanted)) {
    return { reason: 'KF_LOCAL_MODEL_URL is not an address on this computer' };
  }
  let empty;
  for (const url of wanted === undefined ? ON_HOST_MODEL_CANDIDATES : [wanted]) {
    const found = await deps.listModels(url);
    if (found === undefined) continue;
    if (found.models.length > 0) return { url, models: found.models };
    empty = url;
  }
  return {
    reason:
      empty === undefined
        ? 'No model is running on this computer'
        : 'A model server is running on this computer, but it has no model downloaded',
  };
}

export async function readAnswers(state) {
  return readRecord(answersPaths(state).settings);
}

/** Which provider the saved key is for, or undefined when none is saved. */
async function keyOnFileFor(state) {
  if (!existsSync(answersPaths(state).keyFile)) return undefined;
  return (await readAnswers(state))?.cloud?.provider;
}

/**
 * The environment the web application gets for the saved choice. KF_LOCAL_PROVIDER_BASE_URL points
 * the cloud model at a recording double; it must be on this computer, so it can never send a real
 * key somewhere a real provider is not.
 */
async function savedAgentEnv(deps, state) {
  const double = deps.env.KF_LOCAL_PROVIDER_BASE_URL;
  if (double !== undefined && !isLoopbackModelUrl(double)) {
    throw new WorkspaceError(
      'answers_double_not_local',
      'KF_LOCAL_PROVIDER_BASE_URL names an address that is not on this computer.',
      'It exists for test doubles only; unset it.',
    );
  }
  return agentEnv(await readAnswers(state), {
    keyFile: answersPaths(state).keyFile,
    ...(double === undefined ? {} : { providerBaseUrl: double }),
  });
}

/**
 * Check and save a choice: `{ choice, key?, localModel?, cloud? }`. The key, when typed, goes to
 * its 0600 file; a choice without a cloud model removes a saved key. Throws
 * WorkspaceError('invalid_answers') with the problems in plain words; nothing is saved then.
 */
async function saveAnswers(deps, state, input) {
  const files = answersPaths(state);
  const keyOnFile = await keyOnFileFor(state);
  const onHost = usesOnHost(input.choice) ? await detectOnHostModel(deps) : undefined;
  const problems = answersProblems(input, { onHost, keyOnFile });
  if (problems.length > 0) {
    throw new WorkspaceError('invalid_answers', problems.join(' '), 'Change it and try again.');
  }
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  const typed = typeof input.key === 'string' ? input.key.trim() : '';
  if (usesCloud(input.choice) && typed !== '') await writeKeyFile(files.keyFile, typed);
  if (!usesCloud(input.choice)) await rm(files.keyFile, { force: true });
  const localModel =
    onHost?.url === undefined
      ? undefined
      : typeof input.localModel === 'string' && input.localModel !== ''
        ? input.localModel
        : onHost.models[0];
  const saved = {
    version: 1,
    choice: input.choice,
    ...(onHost?.url === undefined ? {} : { onHost: { url: onHost.url, model: localModel } }),
    ...(usesCloud(input.choice) ? { cloud: resolveCloud(input.cloud).cloud } : {}),
  };
  await writeRecord(files.settings, saved);
  return saved;
}

/** What the AI answers page shows: the saved choice and what this computer offers. */
export async function answersState(depsIn = {}) {
  const deps = defaultDeps(depsIn);
  const { state } = workspacePaths(deps.home);
  return {
    saved: answersView(await readAnswers(state), { keyOnFile: await keyOnFileFor(state) }),
    onHost: await detectOnHostModel(deps),
  };
}

/**
 * Change who writes answers, from the AI answers page: save it, and if the web application runs,
 * restart it alone (`stack.sh web-restart`) so it picks the choice up. The API, the worker and the
 * containers are not touched. The organization's routing policy is NOT changed here: that is an
 * institutional act, and the web application's AI answers page offers it to the person as one
 * button (`ceiling` says what it should be).
 */
export async function applyAnswers(input, depsIn = {}) {
  const deps = defaultDeps(depsIn);
  const paths = workspacePaths(deps.home);
  const lock = engineLock(paths);
  try {
    const record = await readRecord(paths.record);
    if (record?.bootstrapped !== true) {
      throw new WorkspaceError(
        'no_workspace',
        'There is no Knowledge Fabric on this computer yet.',
        'Set it up first; the setup page asks who writes answers.',
      );
    }
    await saveAnswers(deps, paths.state, input);
    deps.log(`== AI answers: ${input.choice}`);
    const env = stackEnv(deps.env, {
      state: paths.state,
      organization: record.identity?.organization,
      agent: await savedAgentEnv(deps, paths.state),
    });
    const status = await deps.run('bash', [STACK, 'status'], { env, timeoutMs: MINUTE });
    let restarted = false;
    if (appsRunning(status.stdout).web === true) {
      const result = await deps.run('bash', [STACK, 'web-restart'], {
        env,
        timeoutMs: 5 * MINUTE,
        onLine: deps.log,
      });
      if (result.code !== 0) {
        throw stackFailure('restart its web page', result, path.join(paths.state, 'logs'));
      }
      restarted = true;
    }
    return { restarted, ceiling: ceilingFor(input.choice) };
  } finally {
    lock.release();
  }
}

/** The generated password: created once (O_EXCL, 0600), read on every later run. */
export async function generatedPassword(file) {
  try {
    const fd = openSync(file, 'wx', 0o600);
    writeSync(fd, `${randomBytes(18).toString('base64url')}\n`);
    closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  chmodSync(file, 0o600);
  return (await readFile(file, 'utf8')).trim();
}

/** What runs now: the stack's applications and the workspace's containers. */
async function observe(deps, env) {
  const status = await deps.run('bash', [STACK, 'status'], { env, timeoutMs: MINUTE });
  const apps = appsRunning(status.stdout);
  const ps = await deps.run(
    'docker',
    ['ps', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--format', '{{.Ports}}'],
    { timeoutMs: MINUTE },
  );
  const lines = ps.code === 0 ? ps.stdout.split('\n').filter((l) => l.trim() !== '') : [];
  return { apps, containers: lines.length >= 3, containerPorts: publishedPorts(ps.stdout) };
}

/** An embedding server another stack runs, when one answers and this machine can use it. */
async function chooseEmbedder(deps) {
  const wanted = deps.env.KF_LOCAL_EMBED_URL;
  const candidates = wanted !== undefined ? [wanted] : EMBED_CANDIDATES;
  let url;
  for (const candidate of candidates) {
    if (await deps.probe(`${candidate}/health`)) {
      url = candidate;
      break;
    }
  }
  if (url === undefined) {
    return { reason: 'no embedding server is answering on this computer' };
  }
  if (!existsSync(deps.lamuBin)) return { reason: `no retrieval engine at ${deps.lamuBin}` };
  if (!existsSync(path.join(deps.embedModelDir, 'PROVENANCE.json'))) {
    return { reason: `no prepared embedding model in ${deps.embedModelDir}` };
  }
  return { url };
}

function stackFailure(what, result, logs) {
  const detail = result.timedOut ? 'it took too long and was stopped' : `exit ${result.code}`;
  return new WorkspaceError(
    'stack_failed',
    `Knowledge Fabric could not ${what} (${detail}).`,
    `The details are in ${logs}. Starting again often helps; if it keeps failing, ` +
      'restart the computer, make sure Docker is running, and try once more.',
  );
}

function engineLock(paths) {
  mkdirSync(paths.launcher, { recursive: true, mode: 0o700 });
  const lock = acquireLock(path.join(paths.launcher, 'engine.lock'));
  if (!lock.acquired) {
    throw new WorkspaceError(
      'busy',
      'Knowledge Fabric is already starting or stopping.',
      'Wait for it to finish, then try again.',
    );
  }
  return lock;
}

/**
 * Start the workspace. `request`: identity fields for a first run, `password` (in memory, from
 * the launcher's page) or none (the command line generates one into a 0600 file), `importFolder`.
 */
export async function startWorkspace(request, depsIn = {}) {
  const deps = defaultDeps(depsIn);
  const paths = workspacePaths(deps.home);
  const lock = engineLock(paths);
  try {
    return await start(request, deps, paths);
  } finally {
    lock.release();
  }
}

async function start(request, deps, paths) {
  const { log, step } = deps;
  step('check', 'Checking this computer');
  let record = await readRecord(paths.record);
  const baseEnv = stackEnv(deps.env, {
    state: paths.state,
    organization: record?.identity?.organization ?? request.organization,
  });
  const docker = await deps.run('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeoutMs: MINUTE,
  });
  if (docker.code !== 0) {
    throw new WorkspaceError(
      'docker_unavailable',
      'Docker is not running, and Knowledge Fabric needs it.',
      'Start Docker (or install it), then start Knowledge Fabric again.',
    );
  }
  const now =
    record === null
      ? { apps: {}, containers: false, containerPorts: [] }
      : await observe(deps, baseEnv);
  const decision = decideStart({
    record,
    request,
    apps: now.apps,
    containers: now.containers,
  });
  const identity = decision.identity;
  if (decision.stack !== 'none') {
    const ss = await deps.run('ss', ['-ltnH'], { timeoutMs: MINUTE });
    const conflicts = portConflicts(
      listeningPorts(ss.stdout),
      ownedPorts(now.apps, now.containerPorts),
    );
    if (conflicts.length > 0) throw portRefusal(conflicts);
  }

  // Who writes answers, from the setup page: saved (the key to its 0600 file) before anything
  // starts, so the web application's first start already has it.
  if (request.answers !== undefined) {
    step('answers', 'Saving who writes answers');
    await saveAnswers(deps, paths.state, request.answers);
  }

  let semantic = record?.semantic === true;
  if (decision.stack !== 'none') {
    const embedder = await chooseEmbedder(deps);
    semantic = embedder.url !== undefined;
    log(
      semantic
        ? `== search: semantic, borrowing the embedding server at ${embedder.url}`
        : `== search: lexical only (${embedder.reason}; nothing is downloaded)`,
    );
    const env = stackEnv(deps.env, {
      state: paths.state,
      organization: identity.organization,
      embedUrl: embedder.url,
      agent: await savedAgentEnv(deps, paths.state),
    });
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    chmodSync(paths.state, 0o700);
    const logs = path.join(paths.state, 'logs');
    if (decision.stopFirst) {
      await deps.run('bash', [STACK, 'down'], { env, timeoutMs: 5 * MINUTE, onLine: log });
    }
    if (decision.stack === 'up') {
      step('prepare', 'Preparing Knowledge Fabric (the first time takes several minutes)');
      const up = await deps.run('bash', [STACK, 'up'], {
        env,
        timeoutMs: 60 * MINUTE,
        onLine: log,
      });
      if (up.code !== 0) throw stackFailure('be prepared', up, logs);
      record = { ...(record ?? {}), version: 1, identity, stackInitialized: true };
    } else {
      step('resume', 'Starting Knowledge Fabric');
      const resumed = await deps.run('bash', [STACK, 'resume'], {
        env,
        timeoutMs: 15 * MINUTE,
        onLine: log,
      });
      if (resumed.code !== 0) throw stackFailure('start', resumed, logs);
    }
    record = { ...record, semantic };
    await writeRecord(paths.record, record);
  }

  const settings = settingsFor(paths.state);
  let password = request.password;
  let generated = false;
  if (password === undefined && decision.bootstrap) {
    password = await generatedPassword(paths.passwordFile);
    generated = true;
  } else if (password === undefined && request.importFolder !== undefined) {
    // A later import signs in with the first password while it is still the account's; once the
    // person has chosen their own, `askPassword` (a terminal prompt) is the way in.
    if (existsSync(paths.passwordFile))
      password = (await readFile(paths.passwordFile, 'utf8')).trim();
  }

  if (decision.bootstrap) {
    const { bootstrapWorkspace } = await deps.loadBootstrap();
    const made = await bootstrapWorkspace({ settings, identity, password, step });
    record = {
      ...record,
      ...made,
      bootstrapped: true,
      ...(generated ? { passwordFile: paths.passwordFile } : {}),
    };
    await writeRecord(paths.record, record);
    log(
      `== ${identity.organization}: organization ${made.organizationId}, person ${made.personId}`,
    );
    // The organization's routing policy, matched to the choice the founder just made on the setup
    // page: their own act (set_model_routing_policy, institutional), through the API as them, only
    // when what is in force differs. A failure does not stop the start: the web application's AI
    // answers page shows the same change as one button.
    const ceiling = request.answers === undefined ? undefined : ceilingFor(request.answers.choice);
    if (ceiling !== undefined) {
      const { alignModelRouting, sessionFor } = await deps.loadBootstrap();
      step('routing', 'Recording what may leave this computer');
      try {
        const outcome = await alignModelRouting({
          session: sessionFor({ settings, identity, record, password }),
          ceiling,
        });
        log(`== model routing: ${outcome}`);
      } catch (error) {
        log(`!! the organization's model routing was not recorded (${error?.message ?? error});`);
        log('!! Knowledge Fabric → More → AI answers offers it as one click');
      }
    }
  }

  let imported;
  if (request.importFolder !== undefined) {
    const { importFolder, sessionFor } = await deps.loadBootstrap();
    let session = sessionFor({ settings, identity, record, password });
    const signedIn = await session.token().then(
      () => true,
      () => false,
    );
    if (!signedIn) {
      const typed =
        deps.askPassword === undefined ? undefined : await deps.askPassword(identity.username);
      session =
        typed === undefined ? session : sessionFor({ settings, identity, record, password: typed });
      if (
        typed === undefined ||
        !(await session.token().then(
          () => true,
          () => false,
        ))
      ) {
        throw new WorkspaceError(
          'sign_in_failed',
          `Could not sign in as ${identity.username} to add the files.`,
          'If you have not signed in in the browser yet, do that first (it asks you to choose a ' +
            'password), then run the import again and type that password when asked.',
        );
      }
    }
    imported = await importFolder({ session, folder: request.importFolder, step });
    for (const r of imported.refused) log(`  refused ${r.path}: ${r.code}`);
  }

  if (record.passwordFile !== undefined && record.passwordChangeRequired !== true) {
    const { requirePasswordChange } = await deps.loadBootstrap();
    await requirePasswordChange({ settings, subject: record.subject });
    record = { ...record, passwordChangeRequired: true };
    await writeRecord(paths.record, record);
  }

  step('ready', 'Ready');
  if (!(await deps.probe(`http://127.0.0.1:${PORTS.web}/`, 30_000))) {
    throw new WorkspaceError(
      'web_unavailable',
      'Knowledge Fabric started but its web page is not answering.',
      `The details are in ${path.join(paths.state, 'logs', 'web.log')}. Try starting it again.`,
    );
  }
  return { record, identity, semantic, imported, stack: decision.stack, paths };
}

/** Is the workspace's web application answering? (The launcher's first question.) */
export async function workspaceAnswering(depsIn = {}) {
  const deps = defaultDeps(depsIn);
  return (
    (await deps.probe(`http://127.0.0.1:${PORTS.web}/`)) &&
    (await deps.probe(`http://127.0.0.1:${PORTS.api}/health`))
  );
}

export async function workspaceExists(depsIn = {}) {
  const deps = defaultDeps(depsIn);
  const record = await readRecord(workspacePaths(deps.home).record);
  return record?.bootstrapped === true;
}

async function stopUnit(deps) {
  const active = await deps.run('systemctl', ['--user', 'is-active', '--quiet', UNIT], {
    timeoutMs: 30_000,
  });
  if (active.code === 0) {
    await deps.run('systemctl', ['--user', 'stop', UNIT], { timeoutMs: 2 * MINUTE });
  }
}

export async function stopWorkspace(depsIn = {}) {
  const deps = defaultDeps(depsIn);
  const paths = workspacePaths(deps.home);
  const lock = engineLock(paths);
  try {
    const env = stackEnv(deps.env, { state: paths.state });
    if (existsSync(paths.state)) {
      const down = await deps.run('bash', [STACK, 'down'], {
        env,
        timeoutMs: 5 * MINUTE,
        onLine: deps.log,
      });
      if (down.code !== 0) throw stackFailure('stop', down, path.join(paths.state, 'logs'));
    }
    await stopUnit(deps);
    deps.log('Knowledge Fabric is stopped. Your data is kept.');
  } finally {
    lock.release();
  }
}

export async function statusWorkspace(depsIn = {}) {
  const deps = defaultDeps(depsIn);
  const paths = workspacePaths(deps.home);
  const record = await readRecord(paths.record);
  if (record === null) {
    deps.log('No Knowledge Fabric workspace on this computer yet.');
    return { record: null };
  }
  const identity = record.identity ?? {};
  deps.log(`Knowledge Fabric for ${identity.organization ?? '(not created yet)'}`);
  if (identity.username !== undefined) deps.log(`  sign in as ${identity.username}`);
  if (record.passwordFile !== undefined) deps.log(`  first password in ${record.passwordFile}`);
  deps.log(`  search    ${record.semantic ? 'semantic and lexical' : 'lexical only'}`);
  const status = await deps.run('bash', [STACK, 'status'], {
    env: stackEnv(deps.env, { state: paths.state }),
    timeoutMs: MINUTE,
  });
  for (const line of status.stdout.split('\n')) if (line !== '') deps.log(line);
  return { record, apps: appsRunning(status.stdout) };
}

export async function resetWorkspace({ yes }, depsIn = {}) {
  const deps = defaultDeps(depsIn);
  const paths = workspacePaths(deps.home);
  if (yes !== true) {
    throw new WorkspaceError(
      'needs_yes',
      `Reset deletes this computer's Knowledge Fabric workspace (${PROJECT}): its database, files, ` +
        'sign-ins and settings. Nothing else is touched.',
      'Run `pnpm kf:reset -- --yes` to do it.',
    );
  }
  const lock = engineLock(paths);
  try {
    if (existsSync(path.join(paths.state, 'keycloak-admin-password'))) {
      const reset = await deps.run('bash', [STACK, 'reset'], {
        env: stackEnv(deps.env, { state: paths.state }),
        timeoutMs: 10 * MINUTE,
        onLine: deps.log,
      });
      if (reset.code !== 0) throw stackFailure('be removed', reset, path.join(paths.state, 'logs'));
    }
    await stopUnit(deps);
    await rm(paths.state, { recursive: true, force: true });
    deps.log(`Removed the ${PROJECT} workspace.`);
  } finally {
    lock.release();
    await rm(paths.launcher, { recursive: true, force: true });
  }
}
