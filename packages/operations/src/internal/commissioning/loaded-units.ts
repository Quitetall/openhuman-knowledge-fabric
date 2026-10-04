import { resolve, join } from 'node:path';
import type { CommissioningCheckFn } from './contracts.js';
import {
  readUnitComposition,
  readUnitCompositions,
  reviewedDropIns,
  validServiceName,
} from './unit-composition.js';
import { commissioningDirectives } from './unit-directives.js';
import {
  absolutePath,
  hasControl,
  observeSystemd,
  probeName,
  SYSTEMD_PROPERTIES,
  templateFor,
} from './systemd-observation.js';

function snapshot(value: unknown): { unitPaths: string[]; units: Record<string, string>[] } {
  if (typeof value !== 'object' || value === null) throw new Error('missing observation');
  const { unitPaths, units } = value as Record<string, unknown>;
  if (
    !Array.isArray(unitPaths) ||
    !unitPaths.length ||
    unitPaths.length > 32 ||
    unitPaths.some((path) => typeof path !== 'string' || !absolutePath(path)) ||
    new Set(unitPaths).size !== unitPaths.length ||
    !Array.isArray(units) ||
    units.length > 256
  )
    throw new Error('invalid observation');
  for (const unit of units) {
    if (
      typeof unit !== 'object' ||
      unit === null ||
      Object.keys(unit).length !== SYSTEMD_PROPERTIES.length ||
      SYSTEMD_PROPERTIES.some(
        (property) =>
          typeof unit[property] !== 'string' ||
          unit[property].length > 16384 ||
          hasControl(unit[property]),
      ) ||
      !validServiceName(unit.Id)
    )
      throw new Error('invalid properties');
  }
  return { unitPaths: unitPaths as string[], units: units as Record<string, string>[] };
}
function boolean(value: string): string {
  if (['yes', 'true', 'on', '1'].includes(value)) return 'yes';
  if (['no', 'false', 'off', '0'].includes(value)) return 'no';
  throw new Error('unsupported reviewed boolean');
}
function expanded(value: string, name: string): string {
  if (/%(?!n)/.test(value)) throw new Error('unsupported reviewed specifier');
  return value.replaceAll('%n', name);
}

/** Filesystem agreement plus the system manager's loaded metadata; not process/startup proof. */
export const systemdLoadedUnits: CommissioningCheckFn = async (inputs) => {
  try {
    const shipped = await readUnitCompositions(inputs.shippedUnitDirectory);
    if (!shipped.length || shipped.length > 256) throw new Error('empty or oversized scope');
    const bases = new Map(shipped.map((unit) => [unit.name, unit]));
    const templates = [...bases.keys()].filter((name) => name.endsWith('@.service'));
    const required = [...bases.keys()]
      .filter((name) => !templates.includes(name))
      .concat(templates.map(probeName));
    const observed = snapshot(
      await (inputs.systemdObservation ?? observeSystemd)({
        units: required.filter((name) => !templateFor(name, templates)),
        templates,
      }),
    );
    const byName = new Map(observed.units.map((unit) => [unit.Id!, unit]));
    if (
      byName.size !== observed.units.length ||
      required.some((name) => !byName.has(name)) ||
      [...byName.keys()].some((name) => !required.includes(name) && !templateFor(name, templates))
    )
      throw new Error('incomplete or unscoped observation');
    const installedDirectory = resolve(inputs.systemdDirectory);
    if (!observed.unitPaths.includes(installedDirectory))
      return {
        status: 'unsatisfied',
        detail: 'The declared installed directory is not in the system manager load paths.',
      };
    const mismatches: string[] = [];
    for (const [name, unit] of byName) {
      const baseName = bases.has(name) ? name : templateFor(name, templates)!;
      // Instance names can carry arbitrary caller data. Diagnose only reviewed base names.
      const label = name === baseName ? baseName : `${baseName} instance`;
      const base = bases.get(baseName)!;
      const installed = await readUnitComposition(installedDirectory, name, baseName);
      if (
        installed.baseDigest !== base.baseDigest ||
        !(await reviewedDropIns(baseName, installed.dropIns, inputs.shippedUnitDirectory))
      ) {
        mismatches.push(`${label}: reviewed files`);
        continue;
      }
      const directives = commissioningDirectives(installed.text);
      const scalar = (key: string): string =>
        directives.find(([property]) => property === key)?.[1] ?? '';
      const expected: Record<string, string> = {
        Id: name,
        Names: name,
        LoadState: 'loaded',
        Transient: 'no',
        NeedDaemonReload: 'no',
        FragmentPath: join(installedDirectory, baseName),
        User: scalar('User'),
        Group: scalar('Group'),
        DynamicUser: boolean(scalar('DynamicUser') || 'no'),
        OnFailure: directives
          .filter(([key]) => key === 'OnFailure')
          .map(([, value]) => expanded(value, name))
          .join(' '),
        DropInPaths: installed.dropIns
          .map((fragment) => join(installedDirectory, fragment.relativePath))
          .join(' '),
      };
      if (scalar('NoNewPrivileges')) expected.NoNewPrivileges = boolean(scalar('NoNewPrivileges'));
      if (scalar('MemorySwapMax')) expected.MemorySwapMax = scalar('MemorySwapMax');
      if (scalar('LimitCORE')) {
        const [soft, hard] = scalar('LimitCORE').split(':');
        expected.LimitCORESoft = soft!;
        expected.LimitCORE = hard ?? soft!;
      }
      // Defaulted identities are compared literally; unsupported source specifiers refuse.
      if ([expected.User!, expected.Group!].some((value) => value.includes('%')))
        throw new Error('unsupported reviewed identity');
      const wrong = Object.keys(expected).filter(
        (property) => unit[property] !== expected[property],
      );
      if (wrong.length) mismatches.push(`${label}: ${wrong.join(', ')}`);
    }
    if (mismatches.length)
      return {
        status: 'unsatisfied',
        detail: `Loaded metadata disagrees with reviewed configuration: ${mismatches.join('; ')}.`,
        observed: { units: byName.size, mismatches: mismatches.length },
      };
    return {
      status: 'satisfied',
      detail:
        'Loaded fragments, selected drop-ins, identities, alert targets and declared hardening agree; not startup or reboot evidence.',
      observed: { units: byName.size, loadPaths: observed.unitPaths.length },
    };
  } catch {
    return {
      status: 'unverifiable',
      detail:
        'Cannot obtain a complete bounded system-manager observation and reviewed file composition. No manager command output is disclosed.',
    };
  }
};
