// Root-only local observer: no environments, command lines or credential contents.
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { applicationCredentialBindings } from '../workstation-credentials.mjs';
const ENV = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const UNIT_KEYS = [
  'Id',
  'ActiveState',
  'SubState',
  'MainPID',
  'InvocationID',
  'User',
  'Group',
  'DynamicUser',
];
function refuse() {
  throw new Error('native observation unavailable');
}
export async function protectedNativePath(path, file = false) {
  if (resolve(path) !== path || (await realpath(path)) !== path) refuse();
  const first = await lstat(path);
  if (file && (!first.isFile() || first.nlink !== 1)) refuse();
  for (let at = path; ; at = dirname(at)) {
    const stat = await lstat(at);
    if (
      stat.uid !== 0 ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o7022) !== 0 ||
      (at !== path && !stat.isDirectory())
    )
      refuse();
    if (at === dirname(at)) break;
  }
}
async function text(path, limit = 65536) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const r = await handle.read(buffer, length, buffer.length - length, null);
      if (!r.bytesRead) break;
      length += r.bytesRead;
    }
    if (length > limit) refuse();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await handle.close();
  }
}
function runner(deadline) {
  return (program, args, extra = []) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) refuse();
    const r = spawnSync(program, args, {
      env: ENV,
      cwd: '/',
      encoding: 'utf8',
      timeout: Math.min(5000, remaining),
      maxBuffer: 65536,
      stdio: ['ignore', 'pipe', 'ignore', ...extra],
    });
    if (r.error || r.signal) refuse();
    return r;
  };
}
function properties(raw, keys) {
  const found = {};
  for (const line of raw.trimEnd().split('\n')) {
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    if (at < 1 || !keys.includes(key) || Object.hasOwn(found, key)) refuse();
    found[key] = line.slice(at + 1);
  }
  if (Object.keys(found).length !== keys.length) refuse();
  return found;
}
function integer(value) {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,9})$/.test(value) ||
    Number(value) > 0xffffffff
  )
    refuse();
  return Number(value);
}
/** Internal metadata seam: the real collector and planted parser tests use identical rules. */
export function nativeUnitMetadata(raw) {
  return properties(raw, UNIT_KEYS);
}
export function nativeLocalIdentity(role, configuredGroup, { nss, passwd, groups }) {
  applicationCredentialBindings(role);
  if (configuredGroup && configuredGroup !== (role === 'attestor' ? 'kf-attest' : `kf-${role}`))
    refuse();
  for (const name of ['passwd', 'group']) {
    const lines = nss
      .split('\n')
      .map((line) => line.split('#')[0].trim())
      .filter((line) => line.startsWith(name + ':'));
    if (lines.length !== 1 || lines[0].slice(name.length + 1).trim() !== 'files') refuse();
  }
  const accounts = passwd
    .trimEnd()
    .split('\n')
    .map((line) => line.split(':'));
  if (accounts.some((row) => row.length !== 7)) refuse();
  const selected = accounts.filter((row) => row[0] === `kf-${role}`);
  if (selected.length !== 1) refuse();
  const expectedUid = integer(selected[0][2]);
  let expectedGid = integer(selected[0][3]);
  const allGroups = groups
    .trimEnd()
    .split('\n')
    .map((line) => line.split(':'));
  if (allGroups.some((row) => row.length !== 4)) refuse();
  if (configuredGroup) {
    const group = allGroups.filter((row) => row[0] === configuredGroup);
    if (group.length !== 1) refuse();
    expectedGid = integer(group[0][2]);
  }
  const aliases = accounts
    .filter((row) => integer(row[2]) === expectedUid)
    .map((row) => row[0])
    .sort();
  return { expectedUid, expectedGid, aliases };
}
export function nativeProcessMetadata(pid, { status, cgroup, limits, stat }) {
  const get = (name) => {
    const lines = status.split('\n').filter((line) => line.startsWith(name + ':'));
    if (lines.length !== 1) refuse();
    return lines[0].slice(name.length + 1).trim();
  };
  const identity = (name) => {
    const ids = get(name).split(/\s+/).map(integer);
    if (ids.length !== 4 || ids.some((id) => id !== ids[0])) refuse();
    return ids[0];
  };
  const group = /^0::(\/[^\n]*)\n$/.exec(cgroup)?.[1];
  if (!group || resolve(group) !== group || /[^\x21-\x7e]/.test(group)) refuse();
  const core = /^Max core file size\s+(\d+|unlimited)\s+(\d+|unlimited)\s+bytes\s*$/m.exec(limits);
  if (!core) refuse();
  if (!stat.startsWith(`${pid} (`)) refuse();
  const end = stat.lastIndexOf(')');
  if (end < `${pid} (`.length || stat[end + 1] !== ' ') refuse();
  const rest = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const start = rest[19];
  if (!start || !/^\d+$/.test(start)) refuse();
  return {
    uid: identity('Uid'),
    gid: identity('Gid'),
    noNewPrivileges: integer(get('NoNewPrivs')),
    capEffective: get('CapEff'),
    capPermitted: get('CapPrm'),
    capAmbient: get('CapAmb'),
    coreSoft: core[1],
    coreHard: core[2],
    group,
    start,
  };
}
async function processFacts(pid) {
  const directory = `/proc/${pid}`;
  const facts = nativeProcessMetadata(pid, {
    status: await text(join(directory, 'status')),
    cgroup: await text(join(directory, 'cgroup'), 4096),
    limits: await text(join(directory, 'limits')),
    stat: await text(join(directory, 'stat'), 4096),
  });
  return {
    ...facts,
    memorySwapMax: (await text(`/sys/fs/cgroup${facts.group}/memory.swap.max`, 128)).trim(),
  };
}

/** Library-only unit selector permits attempt-owned public runtime fixtures. The CLI is closed. */
export async function observeNativeConsumer(role, release, unit = `kf-${role}.service`) {
  const handles = [];
  const pin = async (path, flags) => {
    const handle = await open(path, flags);
    handles.push(handle);
    return handle;
  };
  try {
    if (
      process.platform !== 'linux' ||
      process.getuid() !== 0 ||
      !/^[A-Za-z0-9_.@-]{1,128}\.service$/.test(unit)
    )
      refuse();
    const fields = applicationCredentialBindings(role).map(([, name]) => name);
    const helper = join(release, 'tools/kf-credential-custody');
    await protectedNativePath(helper, true);
    if (((await lstat(helper)).mode & 0o100) === 0) refuse();
    await protectedNativePath('/usr/bin/systemctl', true);
    const run = runner(Date.now() + 20000);
    const query = () => {
      const result = run('/usr/bin/systemctl', [
        '--system',
        '--no-pager',
        'show',
        unit,
        `--property=${UNIT_KEYS.join(',')}`,
      ]);
      if (result.status !== 0) refuse();
      return nativeUnitMetadata(result.stdout);
    };
    const before = query();
    if (
      before.Id !== unit ||
      before.User !== `kf-${role}` ||
      before.DynamicUser !== 'no' ||
      !['active', 'activating'].includes(before.ActiveState)
    )
      refuse();
    const pid = integer(before.MainPID);
    if (!pid || !/^[a-f0-9]{32}$/.test(before.InvocationID)) refuse();
    const localFiles = async () => ({
      nss: await text('/etc/nsswitch.conf'),
      passwd: await text('/etc/passwd'),
      groups: await text('/etc/group'),
    });
    const identityFiles = await localFiles();
    const { expectedUid, expectedGid, aliases } = nativeLocalIdentity(
      role,
      before.Group,
      identityFiles,
    );
    const first = await processFacts(pid);
    const namespace = await pin(`/proc/${pid}/ns/mnt`, constants.O_RDONLY);
    const root = await pin(`/proc/${pid}/root`, constants.O_RDONLY | constants.O_DIRECTORY);
    const nsIdentity = await namespace.stat(),
      rootIdentity = await root.stat();
    const inspection = run(
      helper,
      [
        '--inspect',
        String(expectedUid),
        String(expectedGid),
        `/run/credentials/${unit}`,
        fields.join(','),
      ],
      [namespace.fd, root.fd],
    );
    const custody =
      inspection.status === 0
        ? 'satisfied'
        : inspection.status === 1
          ? 'unsatisfied'
          : 'unverifiable';
    const last = await processFacts(pid),
      after = query();
    const currentNs = await pin(`/proc/${pid}/ns/mnt`, constants.O_RDONLY);
    const currentRoot = await pin(`/proc/${pid}/root`, constants.O_RDONLY | constants.O_DIRECTORY);
    const ns = await currentNs.stat(),
      dir = await currentRoot.stat();
    const samePaths =
      ns.ino === nsIdentity.ino &&
      ns.dev === nsIdentity.dev &&
      dir.ino === rootIdentity.ino &&
      dir.dev === rootIdentity.dev;
    const stable =
      samePaths &&
      UNIT_KEYS.every((key) => before[key] === after[key]) &&
      JSON.stringify(identityFiles) === JSON.stringify(await localFiles()) &&
      JSON.stringify(first) === JSON.stringify(last);
    const swaps = await text('/proc/swaps');
    const facts = { ...last };
    delete facts.start;
    delete facts.group;
    return {
      version: 1,
      role,
      pid,
      invocation: after.InvocationID,
      state: after.ActiveState,
      substate: after.SubState,
      expectedUid,
      expectedGid,
      aliases,
      localIdentity: true,
      stable,
      swapInventoryEmpty: /^Filename\s+Type\s+Size\s+Used\s+Priority$/.test(swaps.trim()),
      custody,
      ...facts,
    };
  } catch {
    return null;
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }
}
