import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export interface UnitFragment {
  readonly relativePath: string;
  readonly digest: string;
}
export interface UnitComposition {
  readonly name: string;
  readonly text: string;
  readonly baseDigest: string;
  readonly dropIns: readonly UnitFragment[];
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Reverse systemd's first-choice search order for filename replacement in one directory. */
function directories(name: string): readonly string[] {
  if (!validServiceName(name)) throw new Error('unit name refused');
  const candidates = new Set<string>();
  const expand = (candidate: string): void => {
    if (candidates.has(candidate)) return;
    candidates.add(candidate);
    const [family, instance] = candidate.slice(0, -'.service'.length).split('@');
    if (instance) expand(`${family}@.service`);
    // A trailing dash is already a truncated prefix; skip it to find the next one.
    const prefix = family!.endsWith('-') ? family!.slice(0, -1) : family!;
    const dash = prefix.lastIndexOf('-');
    if (dash > 0) {
      const next = prefix.slice(0, dash + 1);
      expand(`${next}${instance ? `@${instance}` : ''}.service`);
    }
  };
  expand(name);
  return ['service.d', ...[...candidates].reverse().map((candidate) => `${candidate}.d`)];
}
export function validServiceName(name: string): boolean {
  return (
    name.length <= 255 &&
    /^[A-Za-z0-9_.-]+(?:@(?:[A-Za-z0-9_.-]|\\x[0-9a-fA-F]{2})*)?\.service$/.test(name)
  );
}
async function regularText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 1024 * 1024) throw new Error('unit fragment refused');
    // Read at most the observed size plus one; a growing file cannot defeat the bound.
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const chunk = await file.read(bytes, count, bytes.length - count, count);
      if (chunk.bytesRead === 0) break;
      count += chunk.bytesRead;
    }
    const after = await file.stat();
    if (
      count !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('unit fragment changed during inspection');
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, count),
    );
  } finally {
    await file.close();
  }
}

/** Compose files in one declared directory. Other load paths/PID1 state are separate evidence. */
export async function readUnitCompositions(
  directory: string,
  only?: ReadonlySet<string>,
): Promise<readonly UnitComposition[]> {
  const result: UnitComposition[] = [];
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith('.service'))
    .sort()) {
    if (only && !only.has(name)) continue;
    result.push(await readUnitComposition(directory, name));
  }
  return result;
}

/** Inspect an instance using only its exact reviewed template base, without starting it. */
export async function readUnitComposition(
  directory: string,
  name: string,
  baseName = name,
): Promise<UnitComposition> {
  if (
    !validServiceName(name) ||
    !validServiceName(baseName) ||
    (baseName !== name && baseName !== name.replace(/@.+\.service$/, '@.service'))
  )
    throw new Error('unit base refused');
  const base = await regularText(join(directory, baseName));
  const selected = new Map<string, { relativePath: string; text: string }>();
  for (const relative of directories(name)) {
    let entries: string[];
    try {
      if (!(await lstat(join(directory, relative))).isDirectory())
        throw new Error('unit drop-in directory refused');
      entries = await readdir(join(directory, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries.filter((name) => name.endsWith('.conf')).sort()) {
      if (!/^[A-Za-z0-9_.-]+\.conf$/.test(entry)) throw new Error('unit drop-in name refused');
      const relativePath = `${relative}/${entry}`;
      selected.set(entry, {
        relativePath,
        text: await regularText(join(directory, relativePath)),
      });
    }
  }
  const ordered = [...selected.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, fragment]) => fragment);
  // Each file begins outside any section; do not inherit a heading across fragments.
  return {
    name,
    text: [base, ...ordered.map((fragment) => fragment.text)].join('\n[X-KF-Fragment-Boundary]\n'),
    baseDigest: digest(base),
    dropIns: ordered.map((fragment) => ({
      relativePath: fragment.relativePath,
      digest: digest(fragment.text),
    })),
  };
}

const NATIVE = new Map<string, string>([
  ['kf-api.service', 'application-api-workstation-credentials.conf'],
  ['kf-worker.service', 'application-worker-workstation-credentials.conf'],
  ['kf-attestor.service', 'application-attestor-workstation-credentials.conf'],
  ['kf-checkpoint.service', 'application-checkpoint-workstation-credentials.conf'],
  ['kf-storage.service', 'application-storage-workstation-credentials.conf'],
  ['kf-readiness.service', 'application-readiness-workstation-credentials.conf'],
  ['kf-backup.service', 'backup-workstation-credentials.conf'],
  ['kf-backup-offsite.service', 'offsite-b2-workstation-credentials.conf'],
  ['kf-restore-drill.service', 'drill-b2-workstation-credentials.conf'],
  ['kf-alert@.service', 'alert-workstation-credentials.conf'],
  ['kf-alert-heartbeat.service', 'alert-heartbeat-workstation-credentials.conf'],
]);

/** No arbitrary override approval: one exact target-specific template, or no override. */
export async function reviewedDropIns(
  name: string,
  fragments: readonly UnitFragment[],
  shipped: string,
): Promise<boolean> {
  if (fragments.length === 0) return true;
  const template = NATIVE.get(name);
  if (!template || fragments.length !== 1 || fragments[0]!.relativePath !== `${name}.d/${template}`)
    return false;
  try {
    return fragments[0]!.digest === digest(await regularText(join(shipped, template)));
  } catch {
    return false;
  }
}
