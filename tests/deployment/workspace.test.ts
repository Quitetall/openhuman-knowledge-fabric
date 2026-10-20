/**
 * scripts/workspace: one's own Knowledge Fabric, started by one command or one click.
 *
 * What is proved here, without a container: what an argument means; what a start decides from
 * what exists (first `up`, `resume`, or nothing); that a port held by something else refuses the
 * start before the stack script runs; that every stack-script call is pointed at kf-local even
 * when the shell exported a fixture's KF_STACK_PROJECT; that a password reaches no argv, no
 * environment and no output line; and that the launcher's local page answers only on loopback,
 * only with its token, only to its own Host and Origin, and only once at a time.
 *
 * AI answers (scripts/workspace/answers.mjs): what each choice starts the web application with;
 * that a cloud model's API key, planted as a sentinel, lands in a 0600 file and in no argv, no
 * environment, no output line, no saved record and no response; that "on this computer" says
 * plainly when no model runs here; that a change restarts the web application alone; and that
 * no choice asks for a provider ceiling above `internal`.
 *
 * NOT covered here: the stack script itself (tests/deployment/stack-pidfile.test.ts covers its
 * pidfiles), the real bootstrap against PostgreSQL and Keycloak, and the browser. Those were run
 * live (the commit message records it); this file pins the decisions that make them safe.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PORTS,
  WorkspaceError,
  appsRunning,
  decideStart,
  listeningPorts,
  ownedPorts,
  parseWorkspaceArgs,
  passwordProblems,
  portConflicts,
  publishedPorts,
  stackEnv,
  workspacePaths,
} from '../../scripts/workspace/plan.mjs';
import {
  applyAnswers,
  answersState,
  resetWorkspace,
  startWorkspace,
  type EngineDeps,
  type Run,
  type RunOptions,
} from '../../scripts/workspace/engine.mjs';
import {
  ANSWER_CHOICES,
  agentEnv,
  answersPaths,
  answersProblems,
  ceilingFor,
} from '../../scripts/workspace/answers.mjs';
import { createLauncherServer } from '../../scripts/workspace/server.mjs';
import { acquireLock, lockHolder } from '../../scripts/workspace/lock.mjs';
import { desktopEntry, execArg, recordedPath } from '../../scripts/workspace/install-launcher.mjs';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kf-workspace-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function refusal(fn: () => unknown): WorkspaceError {
  try {
    fn();
  } catch (error) {
    if (error instanceof WorkspaceError) return error;
    throw error;
  }
  throw new Error('expected a WorkspaceError');
}

describe('arguments', () => {
  it('reads start options, with or without the `--` pnpm passes through', () => {
    const parsed = parseWorkspaceArgs([
      'start',
      '--',
      '--organization',
      'Acme Engineering',
      '--name=Ada Example',
      '--username',
      'ada',
      '--import',
      '/srv/docs',
    ]);
    expect(parsed).toEqual({
      command: 'start',
      options: {
        organization: 'Acme Engineering',
        name: 'Ada Example',
        username: 'ada',
        import: '/srv/docs',
      },
    });
    expect(parseWorkspaceArgs(['--', 'reset', '--yes'])).toEqual({
      command: 'reset',
      options: { yes: true },
    });
  });

  it('refuses a password on the command line, unknown options and options of another command', () => {
    expect(refusal(() => parseWorkspaceArgs(['start', '--password', 'x'])).message).toMatch(
      /never given on a command line/,
    );
    expect(refusal(() => parseWorkspaceArgs(['start', '--colour', 'x'])).code).toBe('usage');
    expect(refusal(() => parseWorkspaceArgs(['stop', '--yes'])).code).toBe('usage');
    expect(refusal(() => parseWorkspaceArgs(['start', '--name'])).message).toMatch(/needs a value/);
    expect(refusal(() => parseWorkspaceArgs(['launch'])).code).toBe('usage');
  });

  it('holds a typed password to the realm policy', () => {
    const who = { username: 'ada', email: 'ada@kf-local.invalid' };
    expect(passwordProblems('short', 'short', who)).toEqual(['Use at least 14 characters.']);
    expect(passwordProblems('a-long-enough-pass', 'a-long-enough-pasX', who)).toEqual([
      'The two passwords are not the same.',
    ]);
    expect(passwordProblems('a-long-enough-pass', 'a-long-enough-pass', who)).toEqual([]);
  });
});

describe('what a start decides', () => {
  const identity = {
    organization: 'Acme Engineering',
    name: 'Ada Example',
    username: 'ada',
    email: 'ada@kf-local.invalid',
  };
  const allApps = { attestor: true, api: true, worker: true, web: true };

  it('a first run needs an identity, then runs `up` and the bootstrap', () => {
    expect(
      refusal(() => decideStart({ record: null, request: {}, apps: {}, containers: false })).code,
    ).toBe('needs_identity');
    const d = decideStart({
      record: null,
      request: { organization: 'Acme Engineering', name: 'Ada Example', username: 'ada' },
      apps: {},
      containers: false,
    });
    expect(d).toEqual({ identity, stack: 'up', stopFirst: false, bootstrap: true });
  });

  it('a re-run with everything running changes nothing; with anything stopped it resumes', () => {
    const record = { identity, stackInitialized: true, bootstrapped: true };
    expect(decideStart({ record, request: {}, apps: allApps, containers: true })).toMatchObject({
      stack: 'none',
      bootstrap: false,
    });
    expect(
      decideStart({ record, request: {}, apps: { ...allApps, web: false }, containers: true })
        .stack,
    ).toBe('resume');
    expect(decideStart({ record, request: {}, apps: allApps, containers: false }).stack).toBe(
      'resume',
    );
  });

  it('completes an interrupted first run, stopping applications `up` would re-key under', () => {
    expect(
      decideStart({
        record: { identity, stackInitialized: false },
        request: {},
        apps: { api: true },
        containers: true,
      }),
    ).toMatchObject({ stack: 'up', stopFirst: true, bootstrap: true });
    expect(
      decideStart({
        record: { identity, stackInitialized: true },
        request: {},
        apps: allApps,
        containers: true,
      }),
    ).toMatchObject({ stack: 'none', bootstrap: true });
  });

  it('refuses to turn an existing workspace into another one', () => {
    const record = { identity, stackInitialized: true, bootstrapped: true };
    const error = refusal(() =>
      decideStart({ record, request: { username: 'grace' }, apps: allApps, containers: true }),
    );
    expect(error.code).toBe('other_workspace');
    expect(
      decideStart({ record, request: { username: 'ada' }, apps: allApps, containers: true }).stack,
    ).toBe('none');
  });

  it('reads what runs from the stack script, Docker and ss', () => {
    expect(
      appsRunning('  embed     stopped\n  api       running  pid 12\n  web       stopped\n'),
    ).toEqual({ embed: false, api: true, web: false });
    expect(
      publishedPorts('127.0.0.1:15632->5432/tcp\n127.0.0.1:18280->8080/tcp, 8443/tcp\n'),
    ).toEqual([15632, 18280]);
    expect([
      ...listeningPorts('LISTEN 0 511 127.0.0.1:3300 0.0.0.0:*\nLISTEN 0 4096 [::]:4300 [::]:*\n'),
    ]).toEqual([3300, 4300]);
  });
});

describe('ports', () => {
  it('a port something else holds blocks the start; one this workspace holds does not', () => {
    const listening = new Set([PORTS.web, PORTS.postgres, 22]);
    expect(portConflicts(listening, new Set()).map((c) => c.port)).toEqual([
      PORTS.web,
      PORTS.postgres,
    ]);
    const owned = ownedPorts({ web: true }, [PORTS.postgres]);
    expect(portConflicts(listening, owned)).toEqual([]);
  });
});

/** A fake machine: what every command was called with, and canned answers. */
function fakeMachine(answers: { listening?: string; status?: string; ps?: string } = {}) {
  const calls: { command: string; args: readonly string[]; env?: RunOptions['env'] }[] = [];
  const run: Run = (command, args, options = {}) => {
    calls.push({ command, args, env: options.env });
    let stdout = '';
    if (command === 'ss') stdout = answers.listening ?? '';
    if (command === 'docker' && args[0] === 'ps') stdout = answers.ps ?? '';
    if (command === 'bash' && args[1] === 'status') stdout = answers.status ?? '';
    for (const line of ['== a stack line']) options.onLine?.(line);
    return Promise.resolve({ code: 0, stdout, stderr: '', timedOut: false });
  };
  return { calls, run };
}

function fakeBootstrap(seen: { passwords: (string | undefined)[] }) {
  return () =>
    Promise.resolve({
      bootstrapWorkspace: (input: { password?: string; step: (i: string, l: string) => void }) => {
        seen.passwords.push(input.password);
        input.step('organization', 'Creating Acme Engineering');
        return Promise.resolve({
          organizationId: '01900000-0000-7000-8000-000000000001',
          personId: '01900000-0000-7000-8000-000000000002',
          subject: 'subject-1',
          accountCreated: true,
          assignments: { technical_authority: '01900000-0000-7000-8000-000000000003' },
        });
      },
      requirePasswordChange: () => Promise.resolve(),
      sessionFor: () => ({}),
      importFolder: () => Promise.resolve(undefined),
    });
}

describe('a start against a fake machine', () => {
  const request = { organization: 'Acme Engineering', name: 'Ada Example', username: 'ada' };

  it('refuses when a port is held by something else, before the stack script runs', async () => {
    const machine = fakeMachine({ listening: `LISTEN 0 511 127.0.0.1:${PORTS.api} 0.0.0.0:*\n` });
    await expect(
      startWorkspace(request, {
        home,
        env: {},
        run: machine.run,
        probe: () => Promise.resolve(false),
        log: () => {},
        loadBootstrap: fakeBootstrap({ passwords: [] }),
      }),
    ).rejects.toMatchObject({ code: 'port_in_use' });
    expect(machine.calls.some((c) => c.command === 'bash' && c.args[1] === 'up')).toBe(false);
  });

  it('never puts the generated password in an argv, an environment or an output line', async () => {
    const machine = fakeMachine();
    const lines: string[] = [];
    const seen = { passwords: [] as (string | undefined)[] };
    const result = await startWorkspace(request, {
      home,
      env: { KF_STACK_PROJECT: 'kf-veracier', KF_STACK_STATE: '/elsewhere', PATH: '/usr/bin' },
      run: machine.run,
      probe: () => Promise.resolve(true),
      log: (l) => lines.push(l),
      step: (_, l) => lines.push(l),
      loadBootstrap: fakeBootstrap(seen),
    });
    const paths = workspacePaths(home);
    const password = readFileSync(paths.passwordFile, 'utf8').trim();
    expect(password.length).toBeGreaterThanOrEqual(14);
    expect(statSync(paths.passwordFile).mode & 0o777).toBe(0o600);
    expect(statSync(paths.state).mode & 0o777).toBe(0o700);
    expect(seen.passwords).toEqual([password]);
    expect(result.stack).toBe('up');

    const everything = JSON.stringify({ calls: machine.calls, lines, record: result.record });
    expect(everything).not.toContain(password);
    // Every stack-script call is this workspace's, whatever the shell exported.
    const stackCalls = machine.calls.filter((c) => c.command === 'bash');
    expect(stackCalls.map((c) => c.args[1])).toEqual(['up']);
    for (const call of stackCalls) {
      expect(call.env?.KF_STACK_PROJECT).toBe('kf-local');
      expect(call.env?.KF_STACK_STATE).toBe(paths.state);
    }
  });

  it('with a password typed into the launcher page, writes no password file at all', async () => {
    const machine = fakeMachine();
    const seen = { passwords: [] as (string | undefined)[] };
    const typed = 'typed-into-the-page-0123';
    const lines: string[] = [];
    await startWorkspace(
      { ...request, password: typed },
      {
        home,
        env: {},
        run: machine.run,
        probe: () => Promise.resolve(true),
        log: (l) => lines.push(l),
        loadBootstrap: fakeBootstrap(seen),
      },
    );
    expect(seen.passwords).toEqual([typed]);
    expect(() => statSync(workspacePaths(home).passwordFile)).toThrow();
    expect(JSON.stringify({ calls: machine.calls, lines })).not.toContain(typed);
    const record = readFileSync(workspacePaths(home).record, 'utf8');
    expect(record).not.toContain(typed);
  });

  it('a second start with everything running changes nothing', async () => {
    const first = fakeMachine();
    await startWorkspace(request, {
      home,
      env: {},
      run: first.run,
      probe: () => Promise.resolve(true),
      log: () => {},
      loadBootstrap: fakeBootstrap({ passwords: [] }),
    });
    const before = readFileSync(workspacePaths(home).record, 'utf8');
    const running = fakeMachine({
      status: ['attestor', 'api', 'worker', 'web'].map((n) => `  ${n}  running  pid 1`).join('\n'),
      ps: '127.0.0.1:15632->5432/tcp\n127.0.0.1:19200->8333/tcp\n127.0.0.1:18280->8080/tcp\n',
    });
    const seen = { passwords: [] as (string | undefined)[] };
    const again = await startWorkspace(
      {},
      {
        home,
        env: {},
        run: running.run,
        probe: () => Promise.resolve(true),
        log: () => {},
        loadBootstrap: fakeBootstrap(seen),
      },
    );
    expect(again.stack).toBe('none');
    expect(seen.passwords).toEqual([]);
    expect(running.calls.filter((c) => c.command === 'bash').map((c) => c.args[1])).toEqual([
      'status',
    ]);
    expect(running.calls.some((c) => c.command === 'ss')).toBe(false);
    expect(readFileSync(workspacePaths(home).record, 'utf8')).toBe(before);
  });

  it('reset needs yes, and points the stack script only at kf-local', async () => {
    const machine = fakeMachine();
    await expect(
      resetWorkspace({}, { home, run: machine.run, log: () => {} }),
    ).rejects.toMatchObject({ code: 'needs_yes' });
    expect(machine.calls).toEqual([]);
    const paths = workspacePaths(home);
    await startWorkspace(request, {
      home,
      env: {},
      run: machine.run,
      probe: () => Promise.resolve(true),
      log: () => {},
      loadBootstrap: fakeBootstrap({ passwords: [] }),
    });
    writeFileSync(join(paths.state, 'keycloak-admin-password'), 'x\n', { mode: 0o600 });
    await resetWorkspace(
      { yes: true },
      {
        home,
        env: { KF_STACK_PROJECT: 'kf-veracier', KF_VERACIER_STATE: '/x' },
        run: machine.run,
        log: () => {},
      },
    );
    const reset = machine.calls.find((c) => c.command === 'bash' && c.args[1] === 'reset');
    expect(reset?.env?.KF_STACK_PROJECT).toBe('kf-local');
    expect(reset?.env?.KF_STACK_STATE).toBe(paths.state);
    expect(reset?.env?.KF_VERACIER_STATE).toBeUndefined();
    expect(() => statSync(paths.state)).toThrow();
  });

  it('stackEnv sets every KF_STACK_ value and drops inherited fixture names', () => {
    const env = stackEnv(
      { KF_STACK_PG_PORT: '15432', KF_VERACIER_WEB_PORT: '3100', HOME: '/h' },
      { state: '/s', organization: 'Acme' },
    );
    expect(env.KF_STACK_PG_PORT).toBe(String(PORTS.postgres));
    expect(env.KF_VERACIER_WEB_PORT).toBeUndefined();
    expect(env.KF_VERACIER_SEMANTIC).toBe('0');
    expect(env.HOME).toBe('/h');
  });
});

interface Answer {
  status: number;
  body: string;
}

function call(
  port: number,
  path: string,
  {
    method = 'GET',
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = '';
        res.on('data', (d: Buffer) => (text += d.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('the launcher page', () => {
  const token = 'A'.repeat(43);
  const form = {
    organization: 'Acme Engineering',
    name: 'Ada Example',
    username: 'ada',
    password: 'typed-into-the-page-0123',
    confirm: 'typed-into-the-page-0123',
  };

  async function launcher() {
    const started: Record<string, unknown>[] = [];
    const logged: string[] = [];
    const app = createLauncherServer({
      token,
      mode: 'setup',
      log: (l) => logged.push(l),
      start: (request, { step }) => {
        started.push(request);
        step('check', 'Checking this computer');
        return new Promise(() => {});
      },
    });
    const url = await app.listen();
    const port = Number(new URL(url).port);
    return { app, url, port, started, logged };
  }

  it('listens on loopback only, and its URL carries the token', async () => {
    const { app, url } = await launcher();
    try {
      const address = app.server.address();
      expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
      expect(new URL(url).hostname).toBe('127.0.0.1');
      expect(new URL(url).pathname).toBe(`/${token}/`);
    } finally {
      await app.close();
    }
  });

  it('answers nothing without the token, or to another Host', async () => {
    const { app, port } = await launcher();
    try {
      expect((await call(port, `/${token}/`)).status).toBe(200);
      expect((await call(port, '/')).status).toBe(404);
      expect((await call(port, `/${'B'.repeat(43)}/`)).status).toBe(404);
      expect((await call(port, `/${token.slice(1)}/progress`)).status).toBe(404);
      expect((await call(port, `/${token}/`, { headers: { host: 'evil.example' } })).status).toBe(
        421,
      );
    } finally {
      await app.close();
    }
  });

  it('takes the setup only from its own origin, checks it, and never echoes the password', async () => {
    const { app, port, started, logged } = await launcher();
    const json = { 'content-type': 'application/json' };
    const origin = { origin: `http://127.0.0.1:${port}` };
    try {
      const foreign = await call(port, `/${token}/setup`, {
        method: 'POST',
        headers: { ...json, origin: 'http://evil.example' },
        body: JSON.stringify(form),
      });
      expect(foreign.status).toBe(403);
      const mismatch = await call(port, `/${token}/setup`, {
        method: 'POST',
        headers: { ...json, ...origin },
        body: JSON.stringify({ ...form, confirm: 'something-else-entirely' }),
      });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body).toContain('not the same');
      expect(started).toEqual([]);

      const accepted = await call(port, `/${token}/setup`, {
        method: 'POST',
        headers: { ...json, ...origin },
        body: JSON.stringify(form),
      });
      expect(accepted.status).toBe(202);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ username: 'ada', password: form.password });

      const again = await call(port, `/${token}/setup`, {
        method: 'POST',
        headers: { ...json, ...origin },
        body: JSON.stringify(form),
      });
      expect(again.status).toBe(409);
      expect(started).toHaveLength(1);

      const progress = await call(port, `/${token}/progress`);
      expect(JSON.parse(progress.body)).toMatchObject({ state: 'running' });
      const page = await call(port, `/${token}/`);
      for (const text of [progress.body, page.body, mismatch.body, logged.join('\n')]) {
        expect(text).not.toContain(form.password);
      }
    } finally {
      await app.close();
    }
  });
});

describe('one launcher at a time', () => {
  it('a second holder is refused while the first lives; a dead holder’s lock is taken over', () => {
    const file = join(home, 'server.lock');
    const first = acquireLock(file);
    expect(first.acquired).toBe(true);
    const second = acquireLock(file);
    expect(second.acquired).toBe(false);
    expect(lockHolder(file)?.pid).toBe(process.pid);
    if (first.acquired) first.release();
    // A lock naming a pid that does not exist (pid_max is far below this) is stale.
    writeFileSync(file, '4194999\n123\n\n');
    expect(acquireLock(file).acquired).toBe(true);
  });
});

describe('the desktop entry', () => {
  it('quotes its Exec arguments and records a PATH without this run’s node_modules', () => {
    expect(execArg('/opt/my "kf"/$x')).toBe('"/opt/my \\"kf\\"/\\$x"');
    const entry = desktopEntry({ node: '/usr/bin/node', launcher: '/r/l.mjs', icon: '/i.svg' });
    expect(entry).toContain('Exec="/usr/bin/node" "/r/l.mjs"\n');
    expect(entry).toContain('Terminal=false');
    expect(recordedPath('/r/node_modules/.bin:/usr/bin:/r/x/node_modules/y/bin:/bin')).toBe(
      '/usr/bin:/bin',
    );
  });

  it('offers "AI answers" as the icon’s action, running the launcher with `ai`', () => {
    const entry = desktopEntry({ node: '/usr/bin/node', launcher: '/r/l.mjs', icon: '/i.svg' });
    expect(entry).toContain('Actions=ai-answers;\n');
    expect(entry).toContain('[Desktop Action ai-answers]\nName=AI answers\n');
    expect(entry).toContain('Exec="/usr/bin/node" "/r/l.mjs" ai\n');
  });
});

// ── AI answers ──────────────────────────────────────────────────────────────────────────────────

/** Looks like nothing a secret scanner knows, and appears nowhere else in this repository. */
const SENTINEL_KEY = 'kf-sentinel-provider-key-9c41e07b2d';
const OLLAMA = 'http://127.0.0.1:11434';

/** A model server on this computer offering `models`, or none at all. */
function modelsHere(models: readonly string[] | undefined): NonNullable<EngineDeps['listModels']> {
  return (url) =>
    Promise.resolve(
      models !== undefined && url === OLLAMA ? { answering: true, models } : undefined,
    );
}

const runningStatus = ['attestor', 'api', 'worker', 'web']
  .map((n) => `  ${n}  running  pid 1`)
  .join('\n');

function bootstrapped(): void {
  const paths = workspacePaths(home);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.record,
    `${JSON.stringify({ identity: { organization: 'Acme' }, stackInitialized: true, bootstrapped: true })}\n`,
    { mode: 0o600 },
  );
}

describe('AI answers: what each choice starts the web application with', () => {
  const keyFile = '/state/provider-api-key';

  it('maps every choice to the KF_AGENT_* the web application reads, naming the key by file only', () => {
    expect(agentEnv(null, { keyFile })).toEqual({ KF_AGENT_PROVIDER: 'none' });
    expect(agentEnv({ choice: 'off' }, { keyFile })).toEqual({ KF_AGENT_PROVIDER: 'none' });
    expect(
      agentEnv({ choice: 'on_host', onHost: { url: OLLAMA, model: 'qwen3' } }, { keyFile }),
    ).toEqual({
      KF_AGENT_PROVIDER: 'none',
      KF_AGENT_LAMU_URL: OLLAMA,
      KF_AGENT_LAMU_MODEL: 'qwen3',
    });
    const anthropic = {
      provider: 'anthropic',
      name: 'Anthropic',
      transport: 'anthropic' as const,
      model: 'claude-sonnet-5',
    };
    expect(agentEnv({ choice: 'cloud', cloud: anthropic }, { keyFile })).toEqual({
      KF_AGENT_PROVIDER: 'anthropic',
      KF_AGENT_PROVIDER_KEY_FILE: keyFile,
      KF_AGENT_PROVIDER_MODEL: 'claude-sonnet-5',
    });
    const openai = {
      provider: 'openai',
      name: 'OpenAI',
      transport: 'openai_compatible' as const,
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
    };
    expect(
      agentEnv(
        { choice: 'both', onHost: { url: OLLAMA, model: 'qwen3' }, cloud: openai },
        { keyFile },
      ),
    ).toEqual({
      KF_AGENT_PROVIDER: 'openai_compatible',
      KF_AGENT_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
      KF_AGENT_PROVIDER_NAME: 'OpenAI',
      KF_AGENT_PROVIDER_KEY_FILE: keyFile,
      KF_AGENT_PROVIDER_MODEL: 'gpt-5',
      KF_AGENT_LAMU_URL: OLLAMA,
      KF_AGENT_LAMU_MODEL: 'qwen3',
      KF_AGENT_PREFER: 'provider',
    });
  });

  it('refuses an "on this computer" model that is not on this computer', () => {
    expect(() =>
      agentEnv({ choice: 'on_host', onHost: { url: 'http://192.168.1.5:11434' } }, { keyFile }),
    ).toThrow(WorkspaceError);
  });

  it('never asks the organization for a ceiling above internal', () => {
    const asked = ANSWER_CHOICES.map((choice) => ceilingFor(choice));
    expect(asked).toEqual([undefined, 'none', 'internal', 'internal']);
    for (const ceiling of asked) {
      expect(['confidential', 'restricted', 'public']).not.toContain(ceiling);
    }
  });

  it('a stack call never inherits a shell’s KF_AGENT_* or ANTHROPIC_* variables', () => {
    const env = stackEnv(
      {
        KF_AGENT_PROVIDER: 'anthropic',
        KF_AGENT_LAMU_URL: 'http://127.0.0.1:9',
        ANTHROPIC_API_KEY: SENTINEL_KEY,
        ANTHROPIC_BASE_URL: 'https://elsewhere.example',
        HOME: '/h',
      },
      { state: '/s', agent: { KF_AGENT_PROVIDER: 'none' } },
    );
    expect(env.KF_AGENT_PROVIDER).toBe('none');
    expect(env.KF_AGENT_LAMU_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.HOME).toBe('/h');
  });

  it('says plainly when no model runs on this computer, and checks a cloud model’s form', () => {
    expect(
      answersProblems(
        { choice: 'on_host' },
        { onHost: { reason: 'No model is running on this computer' } },
      )[0],
    ).toMatch(/^No model is running on this computer\. Start one/);
    expect(
      answersProblems({ choice: 'cloud', cloud: { provider: 'anthropic' } }, { onHost: undefined }),
    ).toEqual(['Paste the API key for the cloud model.']);
    // A key saved for one provider is not reused for another.
    expect(
      answersProblems(
        { choice: 'cloud', cloud: { provider: 'openai', model: 'gpt-5' } },
        { keyOnFile: 'anthropic' },
      ),
    ).toEqual(['Paste the API key for the cloud model.']);
    const other = answersProblems(
      {
        choice: 'cloud',
        key: SENTINEL_KEY,
        cloud: { provider: 'other', model: 'm', baseUrl: 'http://api.example.com/v1' },
      },
      {},
    );
    expect(other).toEqual(['Type the provider’s address; it starts with https://.']);
    const badKey = answersProblems(
      { choice: 'cloud', key: 'has a space in it 0123456789', cloud: { provider: 'anthropic' } },
      {},
    );
    expect(badKey).toEqual(['That does not look like an API key (one line, no spaces).']);
  });
});

describe('AI answers: the key reaches one 0600 file and nothing else', () => {
  it('from the setup page: saved before the first start, which already has it', async () => {
    const machine = fakeMachine();
    const lines: string[] = [];
    const aligned: string[] = [];
    const bootstrap = fakeBootstrap({ passwords: [] });
    const result = await startWorkspace(
      {
        organization: 'Acme Engineering',
        name: 'Ada Example',
        username: 'ada',
        password: 'typed-into-the-page-0123',
        answers: {
          choice: 'cloud',
          key: SENTINEL_KEY,
          cloud: { provider: 'mistral', model: 'mistral-large-latest' },
        },
      } as unknown as Record<string, string | undefined>,
      {
        home,
        env: {},
        run: machine.run,
        probe: () => Promise.resolve(true),
        listModels: modelsHere(undefined),
        log: (l) => lines.push(l),
        step: (_, l) => lines.push(l),
        loadBootstrap: async () => ({
          ...((await bootstrap()) as object),
          alignModelRouting: ({ ceiling }: { ceiling: string }) => {
            aligned.push(ceiling);
            return Promise.resolve(`set to ${ceiling}`);
          },
        }),
      },
    );
    const { state } = workspacePaths(home);
    const files = answersPaths(state);
    expect(statSync(files.keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(files.keyFile, 'utf8')).toBe(`${SENTINEL_KEY}\n`);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    // The organization's routing, matched to the choice, as the founder's act: internal at most.
    expect(aligned).toEqual(['internal']);
    const up = machine.calls.find((c) => c.command === 'bash' && c.args[1] === 'up');
    expect(up?.env).toMatchObject({
      KF_AGENT_PROVIDER: 'openai_compatible',
      KF_AGENT_PROVIDER_NAME: 'Mistral',
      KF_AGENT_PROVIDER_BASE_URL: 'https://api.mistral.ai/v1',
      KF_AGENT_PROVIDER_KEY_FILE: files.keyFile,
    });
    const everything = JSON.stringify({
      calls: machine.calls,
      lines,
      record: result.record,
      saved: readFileSync(files.settings, 'utf8'),
    });
    expect(everything).not.toContain(SENTINEL_KEY);
  });

  it('from the AI answers page: saved, the web application alone restarted, nothing echoed', async () => {
    bootstrapped();
    const machine = fakeMachine({ status: runningStatus });
    const lines: string[] = [];
    const deps: EngineDeps = {
      home,
      env: { ANTHROPIC_API_KEY: 'inherited-from-the-shell-000000' },
      run: machine.run,
      listModels: modelsHere(['qwen3', 'llama4']),
      log: (l) => lines.push(l),
    };
    const token = 'C'.repeat(43);
    const app = createLauncherServer({
      token,
      mode: 'start',
      log: (l) => lines.push(l),
      start: () => new Promise(() => {}),
      answers: { state: () => answersState(deps), apply: (input) => applyAnswers(input, deps) },
    });
    // `start` mode begins a start at once (here, one that never ends); the page is about after it.
    const port = Number(new URL(await app.listen()).port);
    app.progress.state = 'ready';
    try {
      const headers = { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` };
      const saved = await call(port, `/${token}/ai`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          answers: 'both',
          localModel: 'llama4',
          cloudProvider: 'anthropic',
          cloudModel: 'claude-opus-5-5',
          cloudKey: SENTINEL_KEY,
        }),
      });
      expect(saved.status).toBe(200);
      expect(JSON.parse(saved.body)).toEqual({ ok: true, restarted: true });

      const files = answersPaths(workspacePaths(home).state);
      expect(statSync(files.keyFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(files.keyFile, 'utf8').trim()).toBe(SENTINEL_KEY);

      // Only the web application is restarted, with the choice and the key's FILE.
      const stackCalls = machine.calls.filter((c) => c.command === 'bash').map((c) => c.args[1]);
      expect(stackCalls).toEqual(['status', 'web-restart']);
      const restart = machine.calls.find((c) => c.args[1] === 'web-restart');
      expect(restart?.env).toMatchObject({
        KF_STACK_PROJECT: 'kf-local',
        KF_AGENT_PROVIDER: 'anthropic',
        KF_AGENT_PROVIDER_KEY_FILE: files.keyFile,
        KF_AGENT_LAMU_URL: OLLAMA,
        KF_AGENT_LAMU_MODEL: 'llama4',
        KF_AGENT_PREFER: 'provider',
      });
      expect(restart?.env?.ANTHROPIC_API_KEY).toBeUndefined();

      const state = await call(port, `/${token}/ai/state`);
      expect(JSON.parse(state.body)).toMatchObject({
        saved: { choice: 'both', keyOnFile: true, localModel: 'llama4' },
        onHost: { url: OLLAMA, models: ['qwen3', 'llama4'] },
      });
      const page = await call(port, `/${token}/ai`);
      expect(page.status).toBe(200);

      // A later save that leaves the key empty keeps it; a refused one does not quote what it got.
      const refused = await call(port, `/${token}/ai`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          answers: 'cloud',
          cloudProvider: 'other',
          cloudModel: 'm',
          cloudBaseUrl: `http://${SENTINEL_KEY}.example/v1`,
          cloudKey: SENTINEL_KEY,
        }),
      });
      expect(refused.status).toBe(400);
      expect(readFileSync(files.keyFile, 'utf8').trim()).toBe(SENTINEL_KEY);

      const everything = JSON.stringify({
        bodies: [saved.body, state.body, page.body, refused.body],
        calls: machine.calls,
        lines,
        saved: readFileSync(files.settings, 'utf8'),
        record: readFileSync(workspacePaths(home).record, 'utf8'),
      });
      expect(everything).not.toContain(SENTINEL_KEY);

      // Choosing a model on this computer only removes the saved key.
      const local = await call(port, `/${token}/ai`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ answers: 'on_host', localModel: 'qwen3' }),
      });
      expect(local.status).toBe(200);
      expect(() => statSync(files.keyFile)).toThrow();
    } finally {
      await app.close();
    }
  });

  it('on this computer, with no model running, refuses with what is missing and saves nothing', async () => {
    bootstrapped();
    const machine = fakeMachine({ status: runningStatus });
    await expect(
      applyAnswers(
        { choice: 'on_host' },
        { home, env: {}, run: machine.run, listModels: modelsHere(undefined), log: () => {} },
      ),
    ).rejects.toThrow(/No model is running on this computer/);
    expect(() => statSync(answersPaths(workspacePaths(home).state).settings)).toThrow();
    expect(machine.calls.filter((c) => c.command === 'bash')).toEqual([]);
    // A server that answers but holds no model is named as such.
    await expect(
      applyAnswers(
        { choice: 'on_host' },
        { home, env: {}, run: machine.run, listModels: modelsHere([]), log: () => {} },
      ),
    ).rejects.toThrow(/has no model downloaded/);
  });

  it('the setup page refuses a key-less cloud choice before anything starts, without echoing', async () => {
    const started: unknown[] = [];
    const token = 'D'.repeat(43);
    const app = createLauncherServer({
      token,
      mode: 'setup',
      start: (request) => {
        started.push(request);
        return new Promise(() => {});
      },
      answers: {
        state: () =>
          Promise.resolve({ onHost: { reason: 'No model is running on this computer' } }),
        apply: () => Promise.reject(new Error('not here')),
      },
    });
    const port = Number(new URL(await app.listen()).port);
    try {
      const response = await call(port, `/${token}/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({
          organization: 'Acme Engineering',
          name: 'Ada Example',
          username: 'ada',
          password: 'typed-into-the-page-0123',
          confirm: 'typed-into-the-page-0123',
          answers: 'both',
          cloudProvider: 'openai',
          cloudModel: 'gpt-5',
          cloudKey: `${SENTINEL_KEY} with spaces`,
        }),
      });
      expect(response.status).toBe(400);
      const problems = JSON.parse(response.body).problems as string[];
      expect(problems.some((p) => p.startsWith('No model is running on this computer'))).toBe(true);
      expect(problems).toContain('That does not look like an API key (one line, no spaces).');
      expect(response.body).not.toContain(SENTINEL_KEY);
      expect(started).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
