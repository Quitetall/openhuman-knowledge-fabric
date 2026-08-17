import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommissioningCheckFn, CommissioningInputs } from './contracts.js';

/** One systemd unit, reduced to the directives commissioning cares about. */
export interface UnitFacts {
  readonly name: string;
  readonly user: string | null;
  readonly onFailure: string | null;
  /** Absolute paths this unit names as `EnvironmentFile=` or as a `*_FILE=`/`*_PATH=` value. */
  readonly secretPaths: readonly string[];
  readonly digest: string;
}

const DIRECTIVE = /^\s*([A-Za-z]+)\s*=\s*(.*)$/;
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:_FILE|_KEY_PATH))=(\/[^\s'"]+)/g;
/**
 * `test -s <path>` — the idiom every unit uses to refuse an empty secret placeholder.
 *
 * Added because it was missed. `/etc/kf/preservation-manifest-key` is an Ed25519 private key
 * reached through `backup.env` at runtime rather than through a directive, so the unit names
 * it only in its `ExecStartPre` guard. The posture check therefore never inspected the mode of
 * a private signing key — it reported on the secrets it could see and said nothing about the
 * one it could not, which is the failure mode a verifier exists to prevent.
 *
 * Only `-s`. `-d` is a directory of PUBLIC keys and `-x` is an executable; neither is a secret,
 * and folding them in would make "every secret is closed to group and other" fail on a
 * directory that has to be traversable.
 */
const SECRET_PRESENCE_TEST = /\btest\s+-s\s+(\/[^\s'"]+)/g;

export function parseUnit(name: string, text: string): UnitFacts {
  let user: string | null = null;
  let onFailure: string | null = null;
  const secretPaths = new Set<string>();

  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    const directive = DIRECTIVE.exec(line);
    if (directive === null) continue;
    const [, key, rawValue] = directive as unknown as [string, string, string];
    const value = rawValue.trim();
    if (key === 'User') user = value;
    else if (key === 'OnFailure') onFailure = value;
    else if (key === 'EnvironmentFile') secretPaths.add(value.replace(/^-/, ''));
    // `Environment=`, `ExecStart=` and `ExecStartPre=` all carry `*_FILE=` assignments in the
    // shipped units, because the deployment passes secrets as paths rather than as values.
    // Scanning the whole line rather than a fixed directive list means a secret moved from
    // `Environment=` into the command still gets checked.
    for (const match of value.matchAll(SECRET_ASSIGNMENT)) {
      const path = match[2];
      if (path !== undefined) secretPaths.add(path);
    }
    for (const match of value.matchAll(SECRET_PRESENCE_TEST)) {
      const path = match[1];
      if (path !== undefined) secretPaths.add(path);
    }
  }

  return {
    name,
    user,
    onFailure,
    secretPaths: [...secretPaths].sort(),
    digest: createHash('sha256').update(text).digest('hex'),
  };
}

/**
 * Read the `.service` units in a directory, optionally restricted to a set of names.
 *
 * The restriction is not an optimisation. `/etc/systemd/system` on any real host also holds
 * the units of everything else installed on it, and an unfiltered read made this verifier
 * report that `display-manager.service` declares no `OnFailure=` — true, irrelevant, and
 * enough to fail a correctly commissioned host. Commissioning speaks only for the units this
 * release ships; everything else on the host is somebody else's contract.
 */
export async function readUnits(
  directory: string,
  only?: ReadonlySet<string>,
): Promise<readonly UnitFacts[]> {
  const entries = await readdir(directory);
  const units: UnitFacts[] = [];
  for (const entry of entries.filter((e) => e.endsWith('.service')).sort()) {
    if (only !== undefined && !only.has(entry)) continue;
    units.push(parseUnit(entry, await readFile(join(directory, entry), 'utf8')));
  }
  return units;
}

/** The unit names this release ships, which is the entire scope of every check here. */
async function shippedNames(directory: string): Promise<ReadonlySet<string>> {
  const entries = await readdir(directory);
  return new Set(entries.filter((entry) => entry.endsWith('.service')));
}

/**
 * The host runs the units this release ships, and the identities are separated.
 *
 * Two questions in one check because they have one answer: an installed unit that differs
 * from the shipped one makes every other statement about identity, hardening and alerting a
 * statement about a file nobody is running.
 */
export const unitProvenance: CommissioningCheckFn = async (inputs: CommissioningInputs) => {
  let shipped: readonly UnitFacts[];
  let installed: readonly UnitFacts[];
  try {
    shipped = await readUnits(inputs.shippedUnitDirectory);
  } catch (error: unknown) {
    return {
      status: 'unverifiable',
      detail: `Cannot read the shipped units at ${inputs.shippedUnitDirectory}: ${message(error)}`,
    };
  }
  try {
    installed = await readUnits(inputs.systemdDirectory, new Set(shipped.map((unit) => unit.name)));
  } catch (error: unknown) {
    return {
      status: 'unverifiable',
      detail: `Cannot read installed units at ${inputs.systemdDirectory}: ${message(error)}. Nothing is commissioned until they are installed.`,
    };
  }

  const byName = new Map(installed.map((unit) => [unit.name, unit]));
  const missing = shipped.filter((unit) => !byName.has(unit.name)).map((unit) => unit.name);
  const altered = shipped
    .filter((unit) => byName.get(unit.name)?.digest !== undefined)
    .filter((unit) => byName.get(unit.name)?.digest !== unit.digest)
    .map((unit) => unit.name);

  const api = byName.get('kf-api.service');
  const checkpoint = byName.get('kf-checkpoint.service');
  const identitiesSeparated =
    api?.user !== undefined &&
    api.user !== null &&
    checkpoint?.user !== undefined &&
    checkpoint.user !== null &&
    api.user !== checkpoint.user;

  // Shared identity is only defensible when the units sharing it need exactly the same
  // secrets. This is the check that would have caught what the API-versus-checkpoint
  // comparison above could not: until 2026-08-17 five units ran as `kf`, so the checkpoint
  // signing key was readable by the backup, offsite, readiness and restore-drill jobs. The
  // narrow comparison passed the whole time, because kf-api was not among them.
  //
  // Stated as a property rather than a list of approved pairs, so a NEW unit dropped onto an
  // existing identity is measured against what that identity already reaches instead of
  // against somebody's memory of why the sharing was once fine.
  const byUser = new Map<string, UnitFacts[]>();
  for (const unit of installed) {
    if (unit.user === null) continue;
    byUser.set(unit.user, [...(byUser.get(unit.user) ?? []), unit]);
  }
  const unevenSharing: string[] = [];
  for (const [user, sharing] of byUser) {
    if (sharing.length < 2) continue;
    const shape = (unit: UnitFacts): string => [...unit.secretPaths].sort().join(',');
    const reference = shape(sharing[0]!);
    if (sharing.every((unit) => shape(unit) === reference)) continue;
    const union = [...new Set(sharing.flatMap((unit) => unit.secretPaths))].sort();
    for (const unit of sharing) {
      const surplus = union.filter((path) => !unit.secretPaths.includes(path));
      if (surplus.length > 0) {
        unevenSharing.push(`${unit.name} (as ${user}) also reaches ${surplus.join(', ')}`);
      }
    }
  }

  const unalerted = installed.filter((unit) => unit.onFailure === null).map((unit) => unit.name);

  const observed = {
    shippedUnits: shipped.length,
    installedUnits: installed.length,
    missing: missing.join(', ') || 'none',
    altered: altered.join(', ') || 'none',
    apiUser: api?.user ?? null,
    checkpointUser: checkpoint?.user ?? null,
    withoutOnFailure: unalerted.join(', ') || 'none',
    identitiesReachingSurplusSecrets: unevenSharing.join('; ') || 'none',
  };

  if (missing.length > 0 || altered.length > 0) {
    return {
      status: 'unsatisfied',
      detail:
        `The host is not running this release's units: ${missing.length} missing, ${altered.length} altered. ` +
        'Every hardening, identity and alerting statement below describes a file that is not in force.',
      observed,
    };
  }
  if (!identitiesSeparated) {
    return {
      status: 'unsatisfied',
      detail:
        'The API and the checkpoint signer run as the same system user, so the one secret the API ' +
        'must never read is reachable by it. Filesystem denial cannot separate what the same uid owns.',
      observed,
    };
  }
  if (unevenSharing.length > 0) {
    return {
      status: 'unsatisfied',
      detail:
        'Units sharing a system identity do not need the same secrets, so at least one reaches ' +
        'a key it has no use for. Filesystem permissions cannot separate what one uid owns: ' +
        'give the unit its own identity, or explain why the surplus access is intended.',
      observed,
    };
  }
  if (unalerted.length > 0) {
    return {
      status: 'unsatisfied',
      detail: `${unalerted.length} installed unit(s) declare no OnFailure=, so their failure is silent.`,
      observed,
    };
  }
  return {
    status: 'satisfied',
    detail:
      `All ${shipped.length} shipped units are installed byte-identically, the API (${observed.apiUser}) and ` +
      `checkpoint signer (${observed.checkpointUser}) are separate identities, no identity reaches a secret ` +
      `its unit does not name, and every unit routes failure to an alert.`,
    observed,
  };
};

/**
 * Every secret a unit names is a file the rest of the host cannot read.
 *
 * The deployment passes secrets as PATHS rather than values on purpose — an environment
 * variable is readable from `/proc/<pid>/environ` by anything running as the same user. That
 * only buys anything if the file itself is closed, so this is the check that makes the choice
 * mean something.
 */
export const secretPosture: CommissioningCheckFn = async (inputs: CommissioningInputs) => {
  let installed: readonly UnitFacts[];
  try {
    // Scoped to this release's unit names, like `unitProvenance`: the secrets of everything
    // else installed on the host are not this deployment's to have an opinion about.
    installed = await readUnits(
      inputs.systemdDirectory,
      await shippedNames(inputs.shippedUnitDirectory),
    );
  } catch (error: unknown) {
    return {
      status: 'unverifiable',
      detail: `Cannot read this release's installed units at ${inputs.systemdDirectory}: ${message(error)}`,
    };
  }

  const referenced = [...new Set(installed.flatMap((unit) => unit.secretPaths))].sort();
  if (referenced.length === 0) {
    return {
      status: 'unverifiable',
      detail:
        'No installed unit names a secret file. Either the units are not installed, or the ' +
        'deployment is passing secrets some other way than the reviewed one.',
      observed: { units: installed.length, secretPaths: 0 },
    };
  }

  const absent: string[] = [];
  const exposed: string[] = [];
  for (const path of referenced) {
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        absent.push(`${path} (not a regular file)`);
        continue;
      }
      // Group and other bits both. "Readable by the kf group" is not closed on a host where
      // more than one service runs, and every host that matters runs more than one.
      if ((info.mode & 0o077) !== 0) {
        exposed.push(`${path} (mode ${(info.mode & 0o777).toString(8).padStart(3, '0')})`);
      }
    } catch (error: unknown) {
      absent.push(`${path} (${message(error)})`);
    }
  }

  const observed = {
    secretPaths: referenced.length,
    absent: absent.join('; ') || 'none',
    groupOrWorldReadable: exposed.join('; ') || 'none',
  };
  if (absent.length > 0) {
    return {
      status: 'unverifiable',
      detail: `${absent.length} secret file(s) a unit depends on cannot be inspected, so their posture is unknown.`,
      observed,
    };
  }
  if (exposed.length > 0) {
    return {
      status: 'unsatisfied',
      detail: `${exposed.length} secret file(s) are readable beyond their owner, which is the whole reason for passing paths instead of values.`,
      observed,
    };
  }
  return {
    status: 'satisfied',
    detail: `All ${referenced.length} unit-referenced secret files exist and are closed to group and other.`,
    observed,
  };
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
