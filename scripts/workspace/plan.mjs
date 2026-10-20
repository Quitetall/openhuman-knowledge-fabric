// A Knowledge Fabric workspace of one's own: the decisions, with nothing that touches the machine.
//
// `pnpm kf:start` (scripts/workspace/cli.mjs) and the desktop launcher (launcher.mjs, server.mjs)
// both drive one engine (engine.mjs). Everything that decides — what an argument means, whether a
// re-run starts, resumes or leaves alone, which ports block a start, what the stack script is
// told — is here, pure, so tests/deployment/workspace.test.ts can prove each decision without a
// container.
//
// The workspace is the Véracier fixture stack's machinery (fixtures/veracier/stack/stack.sh,
// parameterized by KF_STACK_*) under a compose project, ports and state directory of its own, so
// it never touches a fixture stack or the default one.

import { homedir } from 'node:os';
import path from 'node:path';

export const PROJECT = 'kf-local';

/** The ports a workspace holds, all on loopback. */
export const PORTS = Object.freeze({
  web: 3300,
  api: 4300,
  keycloak: 18280,
  postgres: 15632,
  objects: 19200,
});

const PORT_PURPOSE = {
  web: 'the web application',
  api: 'the API',
  keycloak: 'the sign-in service (Keycloak)',
  postgres: 'the database (PostgreSQL)',
  objects: 'the file store (SeaweedFS S3)',
};

/** Ports whose holder the stack script tracks by pidfile; the rest are containers. */
const APP_PORTS = { web: 'web', api: 'api' };

/** Embedding servers another stack may already run (Véracier's, then multi's). */
export const EMBED_CANDIDATES = ['http://127.0.0.1:8021', 'http://127.0.0.1:8022'];

/** The authority a workspace's founder holds. */
export const FOUNDER_AUTHORITY = Object.freeze({
  // One role, so the web application's context picker preselects it (preselectedAssignment picks
  // the only assignment). technical_authority because verifying a record and the Needs you queue
  // require it (packages/documents TECHNICAL_AUTHORITY_ROLE; apps/api needs-you.ts). The fixture
  // founders hold project_owner, but nothing in the code is gated on project_owner, and ingest,
  // capture and the role-preset acts are gated on no role at all, so project_owner would add a
  // second choice at every sign-in and no capability.
  roles: ['technical_authority'],
  // Reads everything up to confidential: the clearance, and the same organization-wide ceiling
  // on each assignment (no --role-ceiling, so the ceiling is the clearance).
  clearance: 'confidential',
  // What a folder import is classified at.
  importClassification: 'internal',
});

/** The ingest batch ceiling (apps/api/src/ingest/plan.ts DEFAULT_INGEST_CEILING). */
export const IMPORT_CEILING = 250;

export function workspacePaths(home = homedir()) {
  const state = path.join(home, '.local', 'state', PROJECT);
  return {
    state,
    record: path.join(state, 'workspace.json'),
    passwordFile: path.join(state, 'login-password'),
    launcher: path.join(home, '.local', 'state', `${PROJECT}-launcher`),
  };
}

export class WorkspaceError extends Error {
  /**
   * `code` names the refusal; `message` says what happened in plain words; `advice` says what to
   * do. The launcher's page shows message and advice, never a stack trace.
   */
  constructor(code, message, advice = '') {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.advice = advice;
  }
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;

const USAGE = [
  'pnpm kf:start  -- --organization <name> --name <full name> --username <login>',
  '                  [--email <address>] [--import <folder>]',
  'pnpm kf:stop | pnpm kf:status | pnpm kf:reset -- --yes',
  '',
  'Or `kf workspace start|stop|status|reset ...` once `kf` is installed.',
].join('\n');

export function usage() {
  return USAGE;
}

const FLAGS = new Set(['organization', 'name', 'username', 'email', 'import']);

/** `start|stop|status|reset` and their options. Throws WorkspaceError('usage') on anything else. */
export function parseWorkspaceArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const command = args.shift();
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help', options: {} };
  }
  if (!['start', 'stop', 'status', 'reset'].includes(command)) {
    throw new WorkspaceError('usage', `unknown command ${command}`, USAGE);
  }
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') continue;
    if (a === '--yes' && command === 'reset') {
      options.yes = true;
      continue;
    }
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (match?.[1] === 'password') {
      throw new WorkspaceError(
        'usage',
        'A password is never given on a command line: argv is readable by every local user.',
        USAGE,
      );
    }
    if (match === null || !FLAGS.has(match[1]) || command !== 'start') {
      throw new WorkspaceError('usage', `unknown option ${a} for ${command}`, USAGE);
    }
    let value = match[2];
    if (value === undefined) {
      value = args[i + 1];
      i += 1;
    }
    if (value === undefined || value.startsWith('--')) {
      throw new WorkspaceError('usage', `--${match[1]} needs a value`, USAGE);
    }
    options[match[1]] = value;
  }
  return { command, options };
}

/** The identity a first run creates, checked; `email` defaults to a reserved, undeliverable one. */
export function validateIdentity({ organization, name, username, email }) {
  const problems = [];
  const org = (organization ?? '').trim();
  const full = (name ?? '').trim();
  const user = (username ?? '').trim();
  if (org.length < 2 || org.length > 200) problems.push('organization: 2 to 200 characters');
  if (full.length < 2 || full.length > 120) problems.push('name: 2 to 120 characters');
  if (!USERNAME.test(user))
    problems.push(
      'username: 2 to 63 of a-z, 0-9, dot, dash or underscore, starting with a letter or digit',
    );
  const mail = (email ?? `${user}@${PROJECT}.invalid`).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) problems.push('email: not an address');
  if (problems.length > 0) {
    throw new WorkspaceError('invalid_identity', problems.join('; '), 'Correct it and try again.');
  }
  return { organization: org, name: full, username: user, email: mail };
}

/** The realm's password policy (deploy/keycloak: length(14), maxLength(128), notUsername, notEmail). */
export function passwordProblems(password, confirm, { username, email }) {
  const problems = [];
  if (typeof password !== 'string' || password.length < 14)
    problems.push('Use at least 14 characters.');
  else if (password.length > 128) problems.push('Use at most 128 characters.');
  if (password !== confirm) problems.push('The two passwords are not the same.');
  if (typeof password === 'string' && (password === username || password === email))
    problems.push('The password cannot be your username or email.');
  return problems;
}

/**
 * What a start does, from what exists (`record`, the workspace.json written by earlier runs or
 * null), what was asked (`request`) and what runs (`apps`: name → running; `containers`: the
 * three dependency containers all running).
 *
 *   stack     'up'     first start: dependencies, migrations, build, logins, realm, applications
 *             'resume' a workspace that exists: start what is stopped (no migration, no re-keyed
 *                      login, no build)
 *             'none'   everything already runs; change nothing
 *   stopFirst an earlier first start was interrupted with applications running; `up` re-keys
 *             their logins, so they are stopped first (stack.sh refuses otherwise)
 *   bootstrap the organization, person, account and authority are not all recorded yet
 */
export function decideStart({ record, request, apps, containers }) {
  const asked = Object.fromEntries(
    ['organization', 'name', 'username', 'email'].map((k) => [k, request[k]]),
  );
  let identity;
  if (record?.identity !== undefined) {
    for (const [key, value] of Object.entries(asked)) {
      if (value !== undefined && value.trim() !== record.identity[key]) {
        throw new WorkspaceError(
          'other_workspace',
          `This computer already has a Knowledge Fabric for ${record.identity.organization} ` +
            `(${record.identity.username}); it was asked for a different ${key}.`,
          'Start it without those options, or remove it first with `pnpm kf:reset -- --yes`.',
        );
      }
    }
    identity = record.identity;
  } else {
    if (
      asked.organization === undefined ||
      asked.name === undefined ||
      asked.username === undefined
    ) {
      throw new WorkspaceError(
        'needs_identity',
        'There is no workspace yet, so it needs an organization, your name and a username.',
        USAGE,
      );
    }
    identity = validateIdentity(asked);
  }
  const anyApp = Object.values(apps).some(Boolean);
  const allApps = ['attestor', 'api', 'worker', 'web'].every((n) => apps[n] === true);
  let stack;
  if (record?.stackInitialized !== true) stack = 'up';
  else if (allApps && containers) stack = 'none';
  else stack = 'resume';
  return {
    identity,
    stack,
    stopFirst: stack === 'up' && anyApp,
    bootstrap: record?.bootstrapped !== true,
  };
}

/**
 * The ports a start needs that something else holds. `listening` is every listening loopback or
 * wildcard port; `owned` the ports this workspace's own containers and processes hold.
 */
export function portConflicts(listening, owned) {
  return Object.entries(PORTS)
    .filter(([, port]) => listening.has(port) && !owned.has(port))
    .map(([name, port]) => ({ name, port, purpose: PORT_PURPOSE[name] }));
}

/** Ports this workspace holds, from its running applications and its containers' published ports. */
export function ownedPorts(apps, containerPorts) {
  const owned = new Set(containerPorts);
  for (const [name, app] of Object.entries(APP_PORTS)) if (apps[app]) owned.add(PORTS[name]);
  return owned;
}

export function portRefusal(conflicts) {
  const list = conflicts.map((c) => `${c.port} (${c.purpose})`).join(', ');
  return new WorkspaceError(
    'port_in_use',
    `Another program is already using what Knowledge Fabric needs: port ${list}.`,
    'Close that program (or stop the other Knowledge Fabric using it), then start again.',
  );
}

/** Ports a line of `ss -ltnH` output listens on. */
export function listeningPorts(ssOutput) {
  const ports = new Set();
  for (const line of ssOutput.split('\n')) {
    const local = line.trim().split(/\s+/)[3];
    const m = local === undefined ? null : /:(\d+)$/.exec(local);
    if (m !== null) ports.add(Number(m[1]));
  }
  return ports;
}

/** Host ports published by `docker ps --format '{{.Ports}}'` lines (`127.0.0.1:15632->5432/tcp`). */
export function publishedPorts(dockerPorts) {
  const ports = [];
  for (const m of dockerPorts.matchAll(/:(\d+)->/g)) ports.push(Number(m[1]));
  return ports;
}

/** `stack.sh status` lines (`  api       running  pid 123`) → name → running. */
export function appsRunning(statusOutput) {
  const apps = {};
  for (const line of statusOutput.split('\n')) {
    const m = /^\s+(embed|retrieval|attestor|api|worker|web)\s+(running|stopped)\b/.exec(line);
    if (m !== null) apps[m[1]] = m[2] === 'running';
  }
  return apps;
}

/**
 * The environment the stack script runs under. Every KF_STACK_* value is SET, never inherited:
 * a shell that exported a fixture's KF_STACK_PROJECT must not point `reset` at that fixture's
 * volumes. The Véracier-specific names stack.sh still honours are removed for the same reason.
 */
export function stackEnv(base, { state, organization, embedUrl, skipBuild = false, agent = {} }) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('KF_STACK_') ||
      key.startsWith('KF_VERACIER_') ||
      // Who writes answers is this workspace's saved choice (answers.json), never the shell's:
      // a KF_AGENT_* the shell exported would point the web application at another model, and an
      // ANTHROPIC_* variable would put a key where every process of this user can read it (the
      // web application refuses to start with ANTHROPIC_API_KEY set; config.ts).
      key.startsWith('KF_AGENT_') ||
      key.startsWith('ANTHROPIC_')
    ) {
      delete env[key];
    }
  }
  Object.assign(env, agent);
  Object.assign(env, {
    KF_STACK_PROJECT: PROJECT,
    KF_STACK_STATE: state,
    KF_STACK_WEB_PORT: String(PORTS.web),
    KF_STACK_API_PORT: String(PORTS.api),
    KF_STACK_KEYCLOAK_PORT: String(PORTS.keycloak),
    KF_STACK_PG_PORT: String(PORTS.postgres),
    KF_STACK_OBJECTS_PORT: String(PORTS.objects),
    KF_STACK_FIXTURE: 'none',
    KF_STACK_ORGANIZATION: organization ?? '',
    KF_VERACIER_SEMANTIC: embedUrl === undefined ? '0' : '1',
  });
  if (embedUrl !== undefined) env.KF_STACK_EMBED_URL = embedUrl;
  if (skipBuild) env.KF_STACK_SKIP_BUILD = '1';
  return env;
}

export function settingsFor(state) {
  const web = `http://localhost:${PORTS.web}`;
  const keycloak = `http://localhost:${PORTS.keycloak}`;
  return {
    state,
    api: `http://127.0.0.1:${PORTS.api}`,
    web,
    keycloak,
    ownerUrl: `postgres://kf_owner@localhost:${PORTS.postgres}/kf?sslmode=disable`,
    oidc: {
      issuer: `${keycloak}/realms/knowledge-fabric`,
      clientId: 'knowledge-fabric-web',
      redirectUri: `${web}/auth/callback`,
    },
  };
}

/** What to do next, printed at the end of a command-line start. Never includes a password. */
export function nextSteps({ identity, passwordFile, semantic, imported }) {
  const lines = [
    '',
    `Knowledge Fabric for ${identity.organization} is running.`,
    '',
    `  Open      http://localhost:${PORTS.web}/`,
    `  Sign in   ${identity.username}`,
  ];
  if (passwordFile !== undefined) {
    lines.push(
      `  Password  in ${passwordFile} (owner-only; not shown here).`,
      '            Keycloak asks you to choose your own at first sign-in; the file is then stale',
      '            and you may delete it.',
    );
  }
  lines.push(
    '  Role      technical authority, cleared to confidential (reads, adds and verifies everything',
    '            up to confidential)',
    `  Search    ${semantic ? 'semantic and lexical' : 'lexical only (no embedding server was answering)'}`,
  );
  if (imported !== undefined) lines.push(`  Imported  ${imported}`);
  lines.push(
    '',
    '  Stop      pnpm kf:stop             (your data is kept; pnpm kf:start brings it back)',
    '  Remove    pnpm kf:reset -- --yes   (deletes this workspace and everything in it)',
    '',
  );
  return lines.join('\n');
}
