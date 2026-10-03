// Three closed credential realms share custody and pinned transport, never a general exporter.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';

const SELF = fileURLToPath(import.meta.url);
const PROTOCOL = 'kf-workstation-credentials-v2';
const MIGRATION_PROTOCOL = 'kf-workstation-migration-credentials-v1';
const B2_PROTOCOL = 'kf-workstation-b2-credentials-v1';
const TMPFS = 0x01021994;
const LIMIT = 16_384;
const NAMES = ['alert-ntfy-url', 'alert-heartbeat-url', 'retrieval-index-key'];
const STARTUP = {
  protocol: PROTOCOL,
  root: 'kf-workstation-credentials',
  names: NAMES,
  encode: encodeBundle,
  decode: decodeBundle,
  validate: (values) => values.map(credential),
};
const MIGRATION = {
  protocol: MIGRATION_PROTOCOL,
  root: 'kf-workstation-migration-credentials',
  names: ['database-url', 'rehearsal-database-url', 'rehearsal-receipt-key'],
  encode: encodeMigrationBundle,
  decode: decodeMigrationBundle,
  validate: migrationValues,
};
const B2 = {
  protocol: B2_PROTOCOL,
  root: 'kf-workstation-b2-credentials',
  names: ['b2-endpoint', 'b2-bucket', 'b2-key-id', 'b2-key'],
  encode: encodeB2Bundle,
  decode: decodeB2Bundle,
  validate: b2Values,
};
const BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const GENERATION = /^generation-[A-Za-z0-9]{6}$/;

function refuse() {
  throw new Error('workstation credential handoff refused');
}

function endpoint(value, heartbeat) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\/[^\s\\]+$/.test(value)) {
    refuse();
  }
  if (/[^\x21-\x7e]/.test(value)) refuse();
  const url = new URL(value);
  if (!url.hostname || url.username || url.password || value.includes('?') || value.includes('#')) {
    refuse();
  }
  if (heartbeat && /\/(?:fail|start|log|\d+)\/?$/.test(url.pathname)) refuse();
  return value;
}

function retrievalKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) refuse();
  return value;
}

function credential(value, index) {
  return index === 2 ? retrievalKey(value) : endpoint(value, index === 1);
}

/** Fixed line framing makes extra fields, embedded newlines and ambiguous JSON keys impossible. */
export function decodeBundle(bytes) {
  if (bytes.length > LIMIT) refuse();
  const lines = bytes.toString('utf8').split('\n');
  if (lines.length !== 5 || lines[0] !== PROTOCOL || lines[4] !== '') refuse();
  return lines.slice(1, 4).map(credential);
}

export function encodeBundle(env) {
  const values = [
    endpoint(env.KF_ALERT_NTFY_URL, false),
    endpoint(env.KF_ALERT_HEARTBEAT_URL, true),
    retrievalKey(env.KF_RETRIEVAL_INDEX_KEY_HEX),
  ];
  return Buffer.from(`${PROTOCOL}\n${values.join('\n')}\n`);
}

function migrationDatabase(value, index) {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    !/^postgres(?:ql)?:\/\/[^\s\\]+$/.test(value) ||
    /[^\x21-\x7e]/.test(value)
  ) {
    refuse();
  }
  const url = new URL(value);
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== (index === 0 ? '5432' : '5433') ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(url.username) ||
    !/^[A-Za-z0-9._~-]+$/.test(url.password) ||
    !/^\/[A-Za-z_][A-Za-z0-9_]*$/.test(url.pathname) ||
    /^\/(?:postgres|template0|template1)$/.test(url.pathname) ||
    url.hash ||
    value.includes('#') ||
    (url.search !== '' && url.search !== '?sslmode=disable')
  ) {
    refuse();
  }
  return url;
}

function migrationValues(values) {
  const production = migrationDatabase(values[0], 0);
  const rehearsal = migrationDatabase(values[1], 1);
  if (
    production.username === rehearsal.username ||
    production.password === rehearsal.password ||
    production.pathname === rehearsal.pathname
  ) {
    refuse();
  }
  retrievalKey(values[2]);
  return values;
}

/** The receipt credential stays 64 ASCII hex bytes: HMAC consumes raw bytes, not decoded hex. */
export function decodeMigrationBundle(bytes) {
  if (bytes.length > LIMIT) refuse();
  const lines = bytes.toString('utf8').split('\n');
  if (lines.length !== 5 || lines[0] !== MIGRATION_PROTOCOL || lines[4] !== '') refuse();
  return migrationValues(lines.slice(1, 4));
}

export function encodeMigrationBundle(env) {
  const values = migrationValues([
    env.KF_MIGRATOR_DATABASE_URL,
    env.KF_REHEARSAL_DATABASE_URL,
    env.KF_REHEARSAL_RECEIPT_KEY_HEX,
  ]);
  const bytes = Buffer.from(`${MIGRATION_PROTOCOL}\n${values.join('\n')}\n`);
  if (bytes.length > LIMIT) {
    bytes.fill(0);
    refuse();
  }
  return bytes;
}

function b2Values(values) {
  const [endpoint, bucket, keyId, key] = values;
  if (
    typeof endpoint !== 'string' ||
    !/^https:\/\/s3\.[a-z]{2}-[a-z]+-[0-9]{3}\.backblazeb2\.com\/?$/.test(endpoint) ||
    typeof bucket !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/.test(bucket)
  ) {
    refuse();
  }
  for (const value of [keyId, key]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._/+~=-]{16,512}$/.test(value)) refuse();
  }
  return [endpoint.replace(/\/$/, ''), bucket, keyId, key];
}

/** Exactly four B2 settings, not database, retrieval, signing or recovery credentials. */
export function encodeB2Bundle(env) {
  const values = b2Values([
    env.KF_B2_S3_ENDPOINT,
    env.KF_B2_BUCKET_NAME,
    env.KF_B2_APPLICATION_KEY_ID,
    env.KF_B2_APPLICATION_KEY,
  ]);
  return Buffer.from(`${B2_PROTOCOL}\n${values.join('\n')}\n`);
}

export function decodeB2Bundle(bytes) {
  if (bytes.length > LIMIT) refuse();
  const lines = bytes.toString('utf8').split('\n');
  if (lines.length !== 6 || lines[0] !== B2_PROTOCOL || lines[5] !== '') refuse();
  return b2Values(lines.slice(1, 5));
}

function directory(path, uid, privateMode = false) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o022) !== 0 ||
    (privateMode && (stat.mode & 0o777) !== 0o700) ||
    statfsSync(path).type !== TMPFS
  ) {
    refuse();
  }
}

function runtime(parent, uid, swaps, profile) {
  directory(parent, uid);
  const rows = swaps.trim().split('\n');
  if (rows.length !== 1 || !/^Filename\s+Type\s+Size\s+Used\s+Priority$/.test(rows[0])) refuse();
  const root = join(parent, profile.root);
  if (statfsSync(parent).type !== TMPFS) refuse();
  return root;
}

function readPrivate(path, uid) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== uid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o400 ||
    stat.size > LIMIT
  ) {
    refuse();
  }
  return readFileSync(path, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW });
}

/** Internal filesystem seam; production supplies /run, uid 0 and the live swap table. */
export function runtimeStatus(parent, uid, bootId, swaps) {
  return statusForProfile(parent, uid, bootId, swaps, STARTUP);
}

export function migrationRuntimeStatus(parent, uid, bootId, swaps) {
  return statusForProfile(parent, uid, bootId, swaps, MIGRATION);
}

export function b2RuntimeStatus(parent, uid, bootId, swaps) {
  return statusForProfile(parent, uid, bootId, swaps, B2);
}

function statusForProfile(parent, uid, bootId, swaps, profile) {
  if (!BOOT_ID.test(bootId)) refuse();
  const root = runtime(parent, uid, swaps, profile);
  try {
    directory(root, uid, true);
    const current = join(root, 'current');
    const link = lstatSync(current);
    if (!link.isSymbolicLink() || link.uid !== uid) refuse();
    const target = readlinkSync(current);
    if (!GENERATION.test(target)) refuse();
    const generation = join(root, target);
    directory(generation, uid, true);
    if (readPrivate(join(generation, 'boot-id'), uid) !== bootId) refuse();
    profile.validate(profile.names.map((name) => readPrivate(join(generation, name), uid)));
    return 'ready';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

export function receiveBundle(bytes, parent, uid, bootId, swaps) {
  return receiveForProfile(bytes, parent, uid, bootId, swaps, STARTUP);
}

export function receiveMigrationBundle(bytes, parent, uid, bootId, swaps) {
  return receiveForProfile(bytes, parent, uid, bootId, swaps, MIGRATION);
}

export function receiveB2Bundle(bytes, parent, uid, bootId, swaps) {
  return receiveForProfile(bytes, parent, uid, bootId, swaps, B2);
}

function receiveForProfile(bytes, parent, uid, bootId, swaps, profile) {
  const values = profile.decode(bytes);
  if (!BOOT_ID.test(bootId)) refuse();
  const root = runtime(parent, uid, swaps, profile);
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  directory(root, uid, true);
  const current = join(root, 'current');
  try {
    const stat = lstatSync(current);
    if (!stat.isSymbolicLink() || stat.uid !== uid || !GENERATION.test(readlinkSync(current))) {
      refuse();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const generation = mkdtempSync(join(root, 'generation-'));
  const pending = join(root, `${generation.split('/').at(-1)}.link`);
  try {
    directory(generation, uid, true);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    profile.names.forEach((name, index) =>
      writeFileSync(join(generation, name), values[index], { mode: 0o400, flag: flags }),
    );
    writeFileSync(join(generation, 'boot-id'), bootId, { mode: 0o400, flag: flags });
    symlinkSync(generation.split('/').at(-1), pending);
    renameSync(pending, current);
  } catch (error) {
    rmSync(pending, { force: true });
    rmSync(generation, { recursive: true, force: true });
    throw error;
  }
  return statusForProfile(parent, uid, bootId, swaps, profile);
}

function configFile(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > LIMIT
  ) {
    refuse();
  }
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const keys = ['identityFile', 'knownHostsFile', 'receiverPath', 'secretsCommand'];
  if (JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(keys.sort())) refuse();
  for (const key of keys) {
    if (typeof config[key] !== 'string' || !/^\/[A-Za-z0-9/._-]+$/.test(config[key])) refuse();
    if (config[key].split('/').includes('..')) refuse();
  }
  for (const key of ['identityFile', 'knownHostsFile', 'secretsCommand']) {
    const file = lstatSync(config[key]);
    if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o022) !== 0) refuse();
    if (key === 'identityFile' && (file.mode & 0o077) !== 0) refuse();
  }
  return config;
}

/** Never give SSH, sudo or the remote process the workstation's decrypted environment. */
export function transportEnvironment(env) {
  return { HOME: env.HOME, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
}

function transport(config, action, input, profile) {
  const digest = createHash('sha256').update(readFileSync(SELF)).digest('hex');
  const path = config.receiverPath;
  const command = `set -eu; ulimit -c 0; test "$(/usr/bin/sha256sum '${path}' | /usr/bin/cut -d ' ' -f 1)" = '${digest}'; exec sudo -n /usr/bin/node '${path}' ${action}`;
  const result = spawnSync(
    '/usr/bin/ssh',
    [
      '-T',
      '-F',
      '/dev/null',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${config.knownHostsFile}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'HostKeyAlgorithms=ssh-ed25519',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=1',
      '-i',
      config.identityFile,
      '-p',
      '2222',
      'kfadmin@127.0.0.1',
      command,
    ],
    {
      input,
      timeout: 15_000,
      maxBuffer: LIMIT,
      encoding: 'utf8',
      env: transportEnvironment(process.env),
    },
  );
  // Neither remote stderr nor untrusted stdout is ever forwarded: it could echo a secret.
  if (result.status !== 0 || result.stdout !== `${profile.protocol} ready\n`) refuse();
}

async function boundedInput(stream) {
  const chunks = [];
  let size = 0;
  const timeout = setTimeout(() => stream.destroy(new Error('input deadline')), 10_000);
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > LIMIT) refuse();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
    chunks.forEach((chunk) => chunk.fill(0));
  }
}

async function main() {
  const [action, configPath, ...extra] = process.argv.slice(2);
  if (extra.length !== 0) refuse();
  const prefixes = [
    ['', STARTUP],
    ['migration-', MIGRATION],
    ['b2-', B2],
  ];
  const selected = prefixes.find(([prefix]) =>
    ['receive', 'status', 'send', 'sync'].some((verb) => action === `${prefix}${verb}`),
  );
  if (!selected) refuse();
  const [prefix, profile] = selected;
  const verb = action.slice(prefix.length);
  if (verb === 'receive' || verb === 'status') {
    if (configPath !== undefined || process.getuid() !== 0) refuse();
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const swaps = readFileSync('/proc/swaps', 'utf8');
    let status;
    if (verb === 'receive') {
      const bytes = await boundedInput(process.stdin);
      try {
        status = receiveForProfile(bytes, '/run', 0, bootId, swaps, profile);
      } finally {
        bytes.fill(0);
      }
    } else status = statusForProfile('/run', 0, bootId, swaps, profile);
    if (status !== 'ready') refuse();
    process.stdout.write(`${profile.protocol} ready\n`);
    return;
  }
  if (configPath === undefined) refuse();
  const config = configFile(configPath);
  if (verb === 'send') {
    const bytes = profile.encode(process.env);
    try {
      transport(config, `${prefix}receive`, bytes, profile);
    } finally {
      bytes.fill(0);
    }
  } else {
    try {
      transport(config, `${prefix}status`, undefined, profile);
      return;
    } catch {
      // A reboot, unavailable guest, wrong host key or missing payload cannot be treated as ready.
    }
    const result = spawnSync(
      config.secretsCommand,
      ['run', '--', process.execPath, SELF, `${prefix}send`, configPath],
      {
        timeout: 35_000,
        maxBuffer: LIMIT,
        env: transportEnvironment(process.env),
        stdio: 'pipe',
      },
    );
    if (result.status !== 0) refuse();
  }
  process.stdout.write('workstation credentials delivered\n');
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main().catch(() => {
    process.stderr.write('workstation credential handoff refused; inspect the host locally\n');
    process.exitCode = 1;
  });
}
