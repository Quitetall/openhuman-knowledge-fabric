import { execFile } from 'node:child_process';
import { opendir } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { promisify } from 'node:util';
import type { SystemdObserver, SystemdObservationRequest } from './contracts.js';
import { validServiceName } from './unit-composition.js';

export const SYSTEMD_PROPERTIES = [
  'Id',
  'Names',
  'LoadState',
  'FragmentPath',
  'DropInPaths',
  'NeedDaemonReload',
  'Transient',
  'User',
  'Group',
  'DynamicUser',
  'OnFailure',
  'NoNewPrivileges',
  'MemorySwapMax',
  'LimitCORE',
  'LimitCORESoft',
] as const;
const execute = promisify(execFile);
const MAX_UNITS = 256;
export const probeName = (template: string): string =>
  template.replace('@.service', '@kf-commissioning-probe.service');
export function templateFor(name: string, templates: readonly string[]): string | undefined {
  return templates.find(
    (template) =>
      name.startsWith(template.slice(0, -'.service'.length)) &&
      name.endsWith('.service') &&
      name !== template,
  );
}
export function absolutePath(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && !/\s/.test(path) && !hasControl(path);
}
export function hasControl(value: string, allowLineWhitespace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 32 || code === 127) && !(allowLineWhitespace && (code === 9 || code === 10)))
      return true;
  }
  return false;
}

/** Parse only the requested machine properties; never retain environment/command/credential data. */
export function parseSystemdProperties(text: string): Record<string, string>[] {
  if (text.length > 4 * 1024 * 1024 || hasControl(text, true))
    throw new Error('manager response refused');
  const records: Record<string, string>[] = [];
  for (const block of text.trimEnd().split(/\n\n+/)) {
    const record: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const separator = line.indexOf('=');
      const key = line.slice(0, separator);
      if (
        separator < 0 ||
        !SYSTEMD_PROPERTIES.some((property) => property === key) ||
        Object.hasOwn(record, key) ||
        line.length > 16384
      )
        throw new Error('manager response refused');
      record[key] = line.slice(separator + 1);
    }
    if (Object.keys(record).length !== SYSTEMD_PROPERTIES.length)
      throw new Error('manager properties missing');
    records.push(record);
  }
  if (records.length > MAX_UNITS) throw new Error('manager scope refused');
  return records;
}

/** Include inactive configured instances as well as currently loaded ones. No unit is started. */
export async function configuredInstances(
  paths: readonly string[],
  templates: readonly string[],
): Promise<string[]> {
  const names = new Set<string>();
  for (const path of paths) {
    if (!absolutePath(path)) throw new Error('manager load path refused');
    let entries;
    try {
      entries = await opendir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Preserve the filesystem cause internally; the commissioning result never emits it.
      throw new Error('manager load path unreadable', { cause: error });
    }
    let count = 0;
    for await (const entry of entries) {
      if (++count > 16384) throw new Error('manager load path oversized');
      const name = entry.name.endsWith('.service.d') ? entry.name.slice(0, -2) : entry.name;
      if (!templateFor(name, templates)) continue;
      if (!validServiceName(name)) throw new Error('configured instance refused');
      names.add(name);
      if (names.size > MAX_UNITS) throw new Error('manager scope refused');
    }
  }
  return [...names].sort();
}

/** Fixed local systemctl, sanitized environment, bounded output and deadline. No reload/start. */
export const observeSystemd: SystemdObserver = async (request: SystemdObservationRequest) => {
  const deadline = Date.now() + 20000;
  const query = async (arguments_: readonly string[]): Promise<string> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('manager observation timed out');
    try {
      const result = await execute(
        '/usr/bin/systemctl',
        ['--system', '--no-pager', ...arguments_],
        {
          timeout: Math.min(5000, remaining),
          killSignal: 'SIGKILL',
          maxBuffer: 4 * 1024 * 1024,
          encoding: 'utf8',
          env: {
            PATH: '/usr/bin:/bin',
            LC_ALL: 'C',
            LANG: 'C',
            SYSTEMD_PAGER: 'cat',
            SYSTEMD_COLORS: '0',
          },
        },
      );
      return result.stdout;
    } catch {
      throw new Error('manager observation unavailable');
    }
  };
  if ([...request.units, ...request.templates].some((name) => !validServiceName(name)))
    throw new Error('manager request refused');
  const unitPaths = (await query(['show', '--property=UnitPath', '--value'])).trim().split(/ +/);
  if (
    unitPaths.length > 32 ||
    unitPaths.some((path) => !absolutePath(path)) ||
    new Set(unitPaths).size !== unitPaths.length
  )
    throw new Error('manager load paths refused');
  const names = new Set([...request.units, ...request.templates.map(probeName)]);
  if (request.templates.length) {
    const raw: unknown = JSON.parse(
      await query([
        'list-units',
        '--all',
        '--type=service',
        '--output=json',
        '--',
        ...request.templates.map((template) => template.replace('@.service', '@*.service')),
      ]),
    );
    if (!Array.isArray(raw) || raw.length > MAX_UNITS) throw new Error('manager instances refused');
    for (const entry of raw) {
      const name: unknown =
        typeof entry === 'object' && entry !== null
          ? (entry as Record<string, unknown>).unit
          : undefined;
      if (
        typeof name !== 'string' ||
        !validServiceName(name) ||
        !templateFor(name, request.templates)
      )
        throw new Error('manager instance refused');
      if (names.has(name) && !request.templates.map(probeName).includes(name))
        throw new Error('manager duplicate instance');
      names.add(name);
    }
    for (const name of await configuredInstances(unitPaths, request.templates)) names.add(name);
  }
  if (names.size > MAX_UNITS || Date.now() >= deadline) throw new Error('manager scope refused');
  const units = parseSystemdProperties(
    await query(['show', `--property=${SYSTEMD_PROPERTIES.join(',')}`, '--', ...names]),
  );
  if (
    units.length !== names.size ||
    units.some((unit) => !names.has(unit.Id!)) ||
    new Set(units.map((unit) => unit.Id)).size !== names.size
  )
    throw new Error('manager observation incomplete');
  return { unitPaths, units };
};
