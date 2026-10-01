// One socket-activated key-release connection; no key is accepted from argv or the environment.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statfsSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';

export const PROTOCOL = 'kf-retrieval-key-release-v1';
const SELF = fileURLToPath(import.meta.url);
const SHA256 = /^[0-9a-f]{64}$/;
const TMPFS = 0x01021994;
const REQUEST_LIMIT = PROTOCOL.length + 1 + 64 + 1;
const TIMEOUT = 5000;

function refuse() {
  // No peer-supplied text, response, key bytes or credential paths in errors.
  throw new Error('retrieval key release refused');
}

function privateFile(path, uid, limit, mode, volatile = false) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.uid !== uid ||
    before.nlink !== 1 ||
    before.size > limit ||
    (before.mode & 0o777) !== mode ||
    (volatile && statfsSync(path).type !== TMPFS)
  )
    refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.uid !== uid ||
      opened.nlink !== 1 ||
      opened.size > limit ||
      (opened.mode & 0o777) !== mode
    )
      refuse();
    const bytes = readFileSync(fd);
    if (bytes.length > limit) refuse();
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function directory(path, uid, privateMode = false) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o022) !== 0 ||
    (privateMode && (stat.mode & 0o077) !== 0)
  )
    refuse();
}

function cleanEnvironment() {
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
}

function policy(path, ownerUid) {
  if (!isAbsolute(path)) refuse();
  directory(dirname(path), ownerUid);
  const value = JSON.parse(privateFile(path, ownerUid, 4096, 0o644).toString('utf8'));
  if (
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['allowedUid', 'releaseDirectory', 'releaseManifestSha256']) ||
    !Number.isSafeInteger(value.allowedUid) ||
    value.allowedUid < 0 ||
    value.allowedUid > 0xffffffff ||
    typeof value.releaseDirectory !== 'string' ||
    !isAbsolute(value.releaseDirectory) ||
    value.releaseDirectory === '/' ||
    resolve(value.releaseDirectory) !== value.releaseDirectory ||
    !SHA256.test(value.releaseManifestSha256)
  )
    refuse();
  directory(value.releaseDirectory, ownerUid);
  return value;
}

function peer(helper, ownerUid) {
  const stat = lstatSync(helper);
  if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o022) !== 0) refuse();
  const result = spawnSync(helper, [], {
    stdio: [0, 'pipe', 'pipe'],
    encoding: 'utf8',
    env: cleanEnvironment(),
    timeout: TIMEOUT,
    maxBuffer: 256,
  });
  if (result.status !== 0 || !/^\d+ \d+ [1-9]\d*\n$/.test(result.stdout)) refuse();
  return Number(result.stdout.split(' ')[0]);
}

function pinnedExecutables(value, ownerUid) {
  if (
    realpathSync(SELF) !== join(value.releaseDirectory, 'scripts/deploy/retrieval-key-release.mjs')
  )
    refuse();
  const manifest = readFileSync(join(value.releaseDirectory, 'SHA256SUMS'));
  if (createHash('sha256').update(manifest).digest('hex') !== value.releaseManifestSha256) refuse();
  const lines = manifest.toString('utf8').split('\n');
  for (const path of [
    'tools/kf-peer-credentials',
    'scripts/deploy/migrate-release.sh',
    'scripts/lib/secret.sh',
    'scripts/deploy/retrieval-key-release.mjs',
    'BUILD-METADATA',
  ]) {
    const entries = lines.filter((line) => line.slice(66) === path);
    if (entries.length !== 1 || !/^[0-9a-f]{64} {2}/.test(entries[0])) refuse();
    const location = join(value.releaseDirectory, path);
    let parent = dirname(location);
    while (parent !== value.releaseDirectory) {
      directory(parent, ownerUid);
      parent = dirname(parent);
    }
    const stat = lstatSync(location);
    if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o022) !== 0) refuse();
    if (
      createHash('sha256').update(readFileSync(location)).digest('hex') !== entries[0].slice(0, 64)
    )
      refuse();
  }
}

function verifyRelease(value, ownerUid) {
  const pins = readFileSync(join(value.releaseDirectory, 'BUILD-METADATA'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('dbmate='));
  if (pins.length !== 1 || !/^dbmate=dbmate version \d+\.\d+\.\d+$/.test(pins[0])) refuse();
  const result = spawnSync(
    '/usr/bin/bash',
    [
      join(value.releaseDirectory, 'scripts/deploy/migrate-release.sh'),
      'check',
      value.releaseDirectory,
    ],
    {
      env: {
        ...cleanEnvironment(),
        KF_EXPECTED_RELEASE_OWNER_UID: String(ownerUid),
        KF_EXPECTED_RELEASE_MANIFEST_SHA256: value.releaseManifestSha256,
        KF_DBMATE_BIN: join(value.releaseDirectory, 'tools/dbmate'),
        KF_EXPECTED_DBMATE_VERSION: pins[0].slice('dbmate=dbmate version '.length),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0) refuse();
}

function request(input) {
  return new Promise((resolveRequest, reject) => {
    let bytes = Buffer.alloc(0);
    const deadline = setTimeout(() => done(new Error('retrieval key release refused')), TIMEOUT);
    function done(error) {
      clearTimeout(deadline);
      input.off('data', data);
      input.off('end', end);
      input.off('error', failed);
      input.pause();
      if (error) reject(error);
      else resolveRequest(bytes);
    }
    function data(chunk) {
      if (bytes.length + chunk.length > REQUEST_LIMIT)
        return done(new Error('retrieval key release refused'));
      bytes = Buffer.concat([bytes, chunk]);
    }
    function end() {
      done();
    }
    function failed() {
      done(new Error('retrieval key release refused'));
    }
    input.on('data', data);
    input.once('end', end);
    input.once('error', failed);
  });
}

/** Internal test seam uses another policy owner; the deployed CLI always requires root ownership. */
export async function releaseConnection({
  policyPath,
  credentialsDirectory,
  input = process.stdin,
  output = process.stdout,
  ownerUid = 0,
  swapTable = readFileSync('/proc/swaps', 'utf8'),
}) {
  const value = policy(policyPath, ownerUid);
  // Authenticate executable inputs before invoking anything from the supplied release.
  pinnedExecutables(value, ownerUid);
  const helper = join(value.releaseDirectory, 'tools/kf-peer-credentials');
  if (peer(helper, ownerUid) !== value.allowedUid) refuse();
  const bytes = await request(input);
  if (!bytes.equals(Buffer.from(`${PROTOCOL}\n${value.releaseManifestSha256}\n`))) refuse();
  verifyRelease(value, ownerUid);
  if (typeof credentialsDirectory !== 'string' || !isAbsolute(credentialsDirectory)) refuse();
  directory(credentialsDirectory, process.getuid(), true);
  if (statfsSync(credentialsDirectory).type !== TMPFS) refuse();
  const swaps = swapTable.trim().split('\n');
  if (swaps.length !== 1 || !/^Filename\s+Type\s+Size\s+Used\s+Priority$/.test(swaps[0])) refuse();
  let key;
  let response;
  try {
    key = privateFile(join(credentialsDirectory, 'index-key'), process.getuid(), 65, 0o400, true);
    const hex = key.toString('utf8');
    if (key.length !== 32 && !/^[0-9a-f]{64}\n?$/.test(hex)) refuse();
    const raw = key.length === 32 ? key : Buffer.from(hex.trim(), 'hex');
    response = Buffer.concat([Buffer.from(`${PROTOCOL}\n`), raw]);
    if (raw !== key) raw.fill(0);
    await new Promise((done, reject) => {
      output.once('error', reject);
      output.write(response, (error) => {
        output.off('error', reject);
        if (error) reject(new Error('retrieval key release refused'));
        else done();
      });
    });
  } finally {
    key?.fill(0);
    response?.fill(0);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  try {
    if (process.argv.length !== 3) refuse();
    await releaseConnection({
      policyPath: process.argv[2],
      credentialsDirectory: process.env.CREDENTIALS_DIRECTORY,
    });
  } catch {
    console.warn('retrieval key release refused');
    process.exitCode = 1;
  }
}
