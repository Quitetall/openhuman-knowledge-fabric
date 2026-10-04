// Pure deployment routing. Credential values and process execution do not belong here.
import { isAbsolute, join, resolve } from 'node:path';
import { applicationCredentialBindings } from '../workstation-credentials.mjs';

const WORKING = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_BUCKET_ARTIFACTS',
  'S3_FORCE_PATH_STYLE',
];
const DURABLE = [
  'S3_DURABLE_ENDPOINT',
  'S3_DURABLE_REGION',
  'S3_DURABLE_ACCESS_KEY_ID',
  'S3_DURABLE_BUCKET',
  'S3_DURABLE_FORCE_PATH_STYLE',
];
const IDENTITY = ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URI'];
const LIMINAL = [
  'LIMINAL_COMPILER_PATH',
  'LIMINAL_CARGO_LOCK_PATH',
  'LIMINAL_BWRAP_PATH',
  'LIMINAL_RUNTIME_FILE_PATHS',
  'LIMINAL_EXECUTABLE_SHA256',
  'LIMINAL_CARGO_LOCK_SHA256',
  'LIMINAL_RUNTIME_CLOSURE_SHA256',
];
const ROLES = new Map([
  [
    'api',
    {
      entry: 'apps/api/dist/server.js',
      flags: [],
      public: [
        ...IDENTITY,
        ...WORKING,
        ...DURABLE,
        'KF_RETRIEVAL_SOCKET',
        'KF_WEB_ORIGIN',
        'KF_API_ORIGIN',
        'KF_EFFECTIVE_AT_BACKDATE_DAYS',
        'KF_EFFECTIVE_AT_BACKDATABLE_ACTIONS',
        'KF_SECURE_OBJECT_ERASURE_SIGNER_URL',
        'KF_SECURE_OBJECT_ERASURE_SIGNER_TIMEOUT_MS',
        'KF_PANDOC_PATH',
        'KF_PANDOC_TIMEOUT_MS',
        'KF_PANDOC_MAX_HEAP_MIB',
        'KF_PANDOC_MAX_STDERR_BYTES',
        'LOG_LEVEL',
      ],
      required: [...IDENTITY, ...WORKING.slice(0, 4), ...DURABLE.slice(0, 4)],
    },
  ],
  [
    'worker',
    {
      entry: 'apps/worker/dist/main.js',
      flags: [],
      public: [...WORKING, ...LIMINAL, 'KF_RETRIEVAL_SOCKET', 'WORKER_CONCURRENCY'],
      required: [],
    },
  ],
  [
    'attestor',
    { entry: 'apps/attestor/dist/main.js', flags: [], public: IDENTITY, required: IDENTITY },
  ],
  [
    'checkpoint',
    {
      entry: 'apps/checkpoint/dist/main.js',
      flags: ['--run'],
      public: [
        'CHECKPOINT_SIGNING_KEY_ID',
        'CHECKPOINT_PUBLIC_KEY_DIR',
        'CHECKPOINT_S3_ENDPOINT',
        'CHECKPOINT_S3_REGION',
        'CHECKPOINT_S3_ACCESS_KEY_ID',
        'CHECKPOINT_S3_BUCKET',
      ],
      required: [
        'CHECKPOINT_SIGNING_KEY_ID',
        'CHECKPOINT_PUBLIC_KEY_DIR',
        'CHECKPOINT_S3_ENDPOINT',
        'CHECKPOINT_S3_ACCESS_KEY_ID',
      ],
    },
  ],
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
      public: [
        ...WORKING,
        ...DURABLE,
        'KF_STORAGE_ACTOR',
        'KF_STORAGE_ROLE',
        'KF_STORAGE_ORGANIZATION',
        'KF_STORAGE_CLASSIFICATION',
      ],
      required: [
        ...WORKING.slice(0, 4),
        ...DURABLE.slice(0, 4),
        'KF_STORAGE_ACTOR',
        'KF_STORAGE_ROLE',
        'KF_STORAGE_ORGANIZATION',
        'KF_STORAGE_CLASSIFICATION',
      ],
    },
  ],
  ['readiness', { entry: 'packages/operations/dist/cli.js', flags: [], public: [], required: [] }],
]);
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
  for (const [binding, name] of applicationCredentialBindings(role))
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
