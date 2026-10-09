// Pure deployment routing. Credential values and process execution do not belong here.
import { isAbsolute, join, resolve } from 'node:path';
import PUBLIC from '../../../deploy/systemd/application-public-fields.json' with { type: 'json' };
import { applicationCredentialBindings } from '../workstation-credentials.mjs';

const ROLES = new Map(
  [
    ['api', { entry: 'apps/api/dist/server.js', flags: [] }],
    ['worker', { entry: 'apps/worker/dist/main.js', flags: [] }],
    ['attestor', { entry: 'apps/attestor/dist/main.js', flags: [] }],
    ['checkpoint', { entry: 'apps/checkpoint/dist/main.js', flags: ['--run'] }],
    [
      'storage',
      {
        entry: 'apps/kf-storage/dist/main.js',
        flags: [
          '--replicate',
          '--verify',
          '--older-than-days',
          '30',
          '--collect-orphans',
          '--grace-hours',
          '168',
        ],
      },
    ],
    ['readiness', { entry: 'packages/operations/dist/cli.js', flags: [] }],
    // SAS §100.35: the weekly determinism re-run compiles exactly as the worker does, so it is
    // the worker's account, credentials and public settings with another program. Its work
    // directory is its own: two units sharing a RuntimeDirectory= would remove it under each other.
    [
      'compiler-determinism',
      {
        entry: 'apps/worker/dist/determinism-cli.js',
        flags: ['--limit', '5'],
        account: 'worker',
      },
    ],
  ].map(([role, spec]) => {
    const account = spec.account ?? role;
    return [role, { ...spec, account, ...PUBLIC[account] }];
  }),
);
function refuse() {
  throw new Error('native application binding refused');
}
function absolute(path) {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path === '/' ||
    /[^\x21-\x7e]/.test(path)
  )
    refuse();
  return path;
}
function publicValue(name, value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 8192 ||
    /[^\x20-\x7e]/.test(value)
  )
    refuse();
  if (
    name.endsWith('_ENDPOINT') ||
    name.endsWith('_URL') ||
    name.endsWith('_ORIGIN') ||
    name === 'OIDC_ISSUER' ||
    name === 'OIDC_JWKS_URI'
  ) {
    let url;
    try {
      url = new URL(value);
    } catch {
      refuse();
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    )
      refuse();
  }
  if (name.endsWith('_SOCKET') || name.endsWith('_PATH') || name.endsWith('_KEY_DIR'))
    absolute(value);
  return value;
}

/**
 * The account a role runs as, whose credential set and public settings it uses: the role itself,
 * except a role that is another program of an existing account (compiler-determinism -> worker).
 */
export function applicationConsumerAccount(role) {
  const spec = ROLES.get(role);
  if (!spec) refuse();
  return spec.account;
}

/** Fixed roles/programs, canonical PID1 paths and explicitly selected public settings only. */
export function applicationConsumerPlan(role, root, environment) {
  const spec = ROLES.get(role);
  if (!spec) refuse();
  absolute(root);
  if (environment.KF_SECRET_CUSTODY !== 'systemd') refuse();
  const credentials = absolute(environment.CREDENTIALS_DIRECTORY);
  const work = `/run/kf-${role}-work`;
  const runtime = role === 'attestor' ? ['/run/kf-attestor', work] : [work];
  if (
    JSON.stringify((environment.RUNTIME_DIRECTORY ?? '').split(':').sort()) !==
    JSON.stringify([...runtime].sort())
  )
    refuse();
  const env = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    NODE_ENV: 'production',
    KF_SECRET_CUSTODY: 'systemd',
    CREDENTIALS_DIRECTORY: credentials,
    TMPDIR: work,
  };
  for (const name of spec.public) {
    const value = environment[name];
    if (value !== undefined && value !== '') env[name] = publicValue(name, value);
  }
  for (const name of spec.required) if (env[name] === undefined) refuse();
  for (const [binding, name] of applicationCredentialBindings(spec.account))
    env[binding] = join(credentials, name);
  if (role === 'api')
    Object.assign(env, {
      KF_DEPLOYMENT_PROFILE: 'dogfood',
      KF_TLS_TERMINATED_UPSTREAM: '1',
      HOST: '127.0.0.1',
      PORT: '4000',
      KF_ATTESTOR_SOCKET: '/run/kf-attestor/attestor.sock',
      KF_PROJECTIONS_ARTIFACT: join(
        root,
        'generated/projections/knowledge-fabric.projections.json',
      ),
    });
  if (role === 'attestor') env.KF_ATTESTOR_SOCKET = '/run/kf-attestor/attestor.sock';
  const commands = [];
  if (role === 'readiness')
    commands.push({ executable: '/usr/bin/bash', args: [join(root, 'scripts/timer-liveness.sh')] });
  commands.push({ executable: '/usr/bin/node', args: [join(root, spec.entry), ...spec.flags] });
  return { cwd: root, env, commands };
}
