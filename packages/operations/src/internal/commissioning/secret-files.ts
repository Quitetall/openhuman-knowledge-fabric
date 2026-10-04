import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import type { CommissioningInputs, CommissioningStatus } from './contracts.js';

export interface SecretMetadata {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly regular: boolean;
  readonly acl: string;
}
interface Accounts {
  readonly byUid: ReadonlyMap<number, ReadonlySet<string>>;
  readonly byGid: ReadonlyMap<number, ReadonlySet<string>>;
  readonly byName: ReadonlyMap<string, number>;
}
function refuse(): never {
  throw new Error('secret metadata unavailable');
}
function number(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) refuse();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) refuse();
  return parsed;
}
/** Local account-file scope only; preserve aliases rather than overwriting duplicate UIDs. */
export async function secretAccounts(inputs: CommissioningInputs): Promise<Accounts> {
  const [passwd, group] = await Promise.all([
    readFile(inputs.passwdPath, 'utf8'),
    readFile(inputs.groupPath, 'utf8'),
  ]);
  const byUid = new Map<number, Set<string>>();
  const byGid = new Map<number, Set<string>>();
  const byName = new Map<string, number>();
  const add = (index: Map<number, Set<string>>, id: number, name: string) => {
    const names = index.get(id) ?? new Set<string>();
    names.add(name);
    index.set(id, names);
  };
  for (const line of passwd.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    const name = fields[0];
    if (fields.length !== 7 || !name || byName.has(name)) refuse();
    const uid = number(fields[2]),
      gid = number(fields[3]);
    byName.set(name, uid);
    add(byUid, uid, name);
    add(byGid, gid, name);
  }
  const groups = new Set<number>();
  for (const line of group.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length !== 4 || !fields[0]) refuse();
    const gid = number(fields[2]);
    if (groups.has(gid)) refuse();
    groups.add(gid);
    if (!byGid.has(gid)) byGid.set(gid, new Set());
    for (const member of (fields[3] ?? '').split(',')) if (member) add(byGid, gid, member);
  }
  return { byUid, byGid, byName };
}

/** Open the final component without following links. No credential bytes are read. */
export async function observeSecretFile(path: string): Promise<SecretMetadata> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    let acl = '';
    if (before.isFile() && (before.mode & 0o070) !== 0) {
      // The inherited descriptor binds getfacl to the same inode, not a path re-resolution.
      // Fixed program/environment, bounded output/time and no stderr in the report.
      const result = spawnSync('/usr/bin/getfacl', ['-cpn', '--', '/proc/self/fd/3'], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 16384,
        stdio: ['ignore', 'pipe', 'ignore', file.fd],
      });
      if (result.error || result.signal || result.status !== 0) refuse();
      acl = result.stdout;
    } else {
      // With a zero group-class mask, named ACL entries cannot grant any effective access.
      const permissions = (bits: number) =>
        `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
      acl = `user::${permissions((before.mode >> 6) & 7)}\ngroup::---\nother::${permissions(before.mode & 7)}\n`;
    }
    const after = await file.stat();
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size
    )
      refuse();
    return {
      uid: after.uid,
      gid: after.gid,
      mode: after.mode,
      nlink: after.nlink,
      size: after.size,
      regular: after.isFile(),
      acl,
    };
  } finally {
    await file.close();
  }
}

function metadata(value: unknown): SecretMetadata {
  if (typeof value !== 'object' || value === null) refuse();
  const v = value as Record<string, unknown>;
  for (const key of ['uid', 'gid', 'mode', 'nlink', 'size']) {
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0) refuse();
  }
  if (typeof v.regular !== 'boolean' || typeof v.acl !== 'string' || v.acl.length > 16384) refuse();
  return v as unknown as SecretMetadata;
}
interface AclEntry {
  tag: string;
  id: number | null;
  bits: number;
}
function aclEntries(text: string, mode: number): readonly AclEntry[] {
  const entries: AclEntry[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match =
      /^(user|group|mask|other):(\d*):([r-][w-][x-])(?:\s+#effective:[r-][w-][x-])?$/.exec(line);
    if (!match || seen.has(`${match[1]}:${match[2]}`)) refuse();
    seen.add(`${match[1]}:${match[2]}`);
    const tag = match[1]!,
      id = match[2] ? number(match[2]) : null;
    if (id !== null && tag !== 'user' && tag !== 'group') refuse();
    const permissions = match[3]!;
    entries.push({
      tag,
      id,
      bits:
        (permissions[0] === 'r' ? 4 : 0) |
        (permissions[1] === 'w' ? 2 : 0) |
        (permissions[2] === 'x' ? 1 : 0),
    });
  }
  const base = (tag: string) => entries.find((e) => e.tag === tag && e.id === null)?.bits;
  if (
    base('user') !== ((mode >> 6) & 7) ||
    base('other') !== (mode & 7) ||
    base('group') === undefined
  )
    refuse();
  if ((base('mask') ?? base('group')) !== ((mode >> 3) & 7)) refuse();
  if (entries.some((e) => e.id !== null) && base('mask') === undefined) refuse();
  return entries;
}
export function secretFileVerdict(
  value: unknown,
  accounts: Accounts,
  entitled: ReadonlySet<string>,
): { status: CommissioningStatus; reason: string } {
  try {
    const info = metadata(value);
    const bad = (reason: string) => ({ status: 'unsatisfied' as const, reason });
    if (!info.regular || info.nlink !== 1 || info.size === 0)
      return bad('not a nonempty single-link regular file');
    if ((info.mode & 0o007) !== 0) return bad('world-readable or writable');
    if ((info.mode & 0o111) !== 0 || (info.mode & 0o7000) !== 0)
      return bad('executable or special mode');
    const allowedUid = (uid: number): boolean | null => {
      if (uid === 0) return true; // Explicit trusted host custodian, not a service-delivery claim.
      const names = accounts.byUid.get(uid);
      if (!names?.size) return null;
      return [...names].every((name) => entitled.has(name));
    };
    const owner = allowedUid(info.uid);
    if (owner === null) refuse();
    if (!owner) return bad('owner or UID alias is not entitled');
    const groupAllowed = (gid: number) => {
      const names = accounts.byGid.get(gid);
      if (!names) refuse();
      return [...names].every((name) => {
        const uid = accounts.byName.get(name);
        if (uid === undefined) return false;
        const result = allowedUid(uid);
        if (result === null) refuse();
        return result;
      });
    };
    const entries = aclEntries(info.acl, info.mode);
    const mask = entries.find((e) => e.tag === 'mask')?.bits ?? 7;
    for (const entry of entries) {
      if ((entry.bits & mask) === 0) continue;
      if (entry.tag === 'user' && entry.id !== null) {
        const allowed = allowedUid(entry.id);
        if (allowed === null) refuse();
        if (!allowed) return bad('named ACL user or UID alias is not entitled');
      }
      if (entry.tag === 'group' && !groupAllowed(entry.id ?? info.gid))
        return bad('group or named ACL group is not entitled');
    }
    for (const name of entitled) if (!accounts.byName.has(name)) refuse();
    return { status: 'satisfied', reason: 'metadata and local account readers checked' };
  } catch {
    return {
      status: 'unverifiable',
      reason: 'metadata, ACL or account identity could not be established',
    };
  }
}
