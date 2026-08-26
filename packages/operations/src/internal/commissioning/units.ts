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
 * Added because it was missed. `/etc/kf/backup/preservation-manifest-key` is an Ed25519 private key
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
/**
 * Assignments that name a path but not a secret.
 *
 * `SECRET_ASSIGNMENT` matches on the SUFFIX `_FILE`, which is a good default — the deployment
 * passes secrets as paths, and a new secret named `*_FILE` gets checked without anyone
 * remembering to add it. It also catches things that are merely files.
 *
 * `KF_MIGRATION_LOCK_FILE=/run/kf-migrate/migration.lock` is the one in the shipped units, and
 * it made `secret_posture` impossible to satisfy. A lock exists only while `kf-migrate` is
 * running; at rest `stat` returns ENOENT, the path lands in `absent`, and the check reports
 * `unverifiable` — permanently, on a correctly built host. Measured on the first real host
 * install 2026-08-26: "1 secret file(s) a unit depends on cannot be inspected", the sole
 * entry being that lock. A check that cannot pass is one of the shapes this repository keeps
 * removing, and it would have blocked 8/8 and therefore ADR 0004's criterion 3 forever.
 *
 * ENUMERATED, NOT INFERRED. The rule stays fail-closed: an unrecognised `*_FILE` is still
 * treated as a secret. Excluding by path instead — anything under `/run`, say — would have
 * been the tempting version and is the wrong one, because systemd delivers real credentials
 * under `/run/credentials`, and a rule written today would silently stop inspecting them.
 */
const NOT_A_SECRET = /_LOCK_FILE$/;

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
      const [, name, path] = match;
      if (name === undefined || path === undefined) continue;
      if (NOT_A_SECRET.test(name)) continue;
      secretPaths.add(path);
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

  // Every unit routes failure to an alert — except the alert path itself, which must NOT.
  //
  // `kf-alert@.service` is where every other unit's `OnFailure=` points. If it pointed its own
  // failure back at itself, a host whose webhook endpoint is unreachable would spawn an alert
  // about the alert about the alert without bound, at the moment an operator can least afford
  // it. The heartbeat is the same argument: a delivery path that has stopped working cannot
  // report that through the delivery path that has stopped working.
  //
  // Checked in BOTH directions rather than skipped, because "this unit is exempt" is exactly
  // the kind of exception that quietly grows. A unit outside this set with no OnFailure= fails
  // silently; a unit inside it WITH one is an alert loop.
  const alertPath = new Set(['kf-alert@.service', 'kf-alert-heartbeat.service']);
  const unalerted = installed
    .filter((unit) => !alertPath.has(unit.name))
    .filter((unit) => unit.onFailure === null)
    .map((unit) => unit.name);
  const selfAlerting = installed
    .filter((unit) => alertPath.has(unit.name))
    .filter((unit) => unit.onFailure !== null)
    .map((unit) => unit.name);

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
  if (selfAlerting.length > 0) {
    return {
      status: 'unsatisfied',
      detail:
        `${selfAlerting.length} unit(s) on the alert path declare OnFailure=, which is a loop: ` +
        'a host whose endpoint is unreachable would alert about the alert without bound.',
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
 * Who, besides root, can read a file owned by this group.
 *
 * `/etc/group` lists supplementary members only; a user whose PRIMARY group this is does not
 * appear there, which is exactly the case for every `useradd --user-group` identity the
 * deployment creates. Reading both files is therefore not belt-and-braces — `/etc/group` alone
 * would report that `kf-api` cannot read its own group's files.
 */
async function groupReaders(gid: number): Promise<readonly string[]> {
  const [groupFile, passwdFile] = await Promise.all([
    readFile('/etc/group', 'utf8'),
    readFile('/etc/passwd', 'utf8'),
  ]);

  const readers = new Set<string>();
  for (const line of groupFile.split('\n')) {
    const [, , id, members] = line.split(':');
    if (id === undefined || Number(id) !== gid) continue;
    for (const member of (members ?? '').split(',')) if (member !== '') readers.add(member);
  }
  for (const line of passwdFile.split('\n')) {
    const [name, , , primary] = line.split(':');
    if (name === undefined || primary === undefined) continue;
    if (Number(primary) === gid) readers.add(name);
  }
  return [...readers].sort();
}

/**
 * Every secret a unit names is a file no identity but that unit's own can read.
 *
 * The deployment passes secrets as PATHS rather than values on purpose — an environment
 * variable is readable from `/proc/<pid>/environ` by anything running as the same user. That
 * only buys anything if the file itself is closed, so this is the check that makes the choice
 * mean something.
 *
 * "CLOSED" IS ABOUT IDENTITIES, NOT MODE BITS. This tested `mode & 0o077` until 2026-08-26 and
 * refused five files on the first real host install:
 *
 *   /etc/kf/api.env (mode 640)   root:kf-api
 *
 * `api.env.example` opens with "Non-secret API routing. Install as /etc/kf/api.env, owned
 * root:kf-api, mode 0640", the README installs exactly that, and the check called it exposed.
 * One of the three had to be wrong, and it was the check: `0640 root:kf-api` is BETTER than
 * `0600 kf-api:kf-api`, because root owning it means the service cannot rewrite its own
 * configuration, and the group holds exactly the one identity that reads it.
 *
 * So group-read is permitted when every reader of that group is the unit's own `User=`, and
 * refused otherwise. World-read is still refused unconditionally — no argument reaches it.
 * Adding a second member to `kf-api` makes these files fail again, which is the property that
 * was actually wanted all along.
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

  // Which identities legitimately read each path — the `User=` of every unit that names it.
  const entitled = new Map<string, Set<string>>();
  for (const unit of installed) {
    for (const path of unit.secretPaths) {
      const users = entitled.get(path) ?? new Set<string>();
      if (unit.user !== null) users.add(unit.user);
      entitled.set(path, users);
    }
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
      const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
      // World first, and unconditionally. Nothing about which service owns a file makes it
      // acceptable for every account on the host to read it.
      if ((info.mode & 0o007) !== 0) {
        exposed.push(`${path} (mode ${mode}, world-readable)`);
        continue;
      }
      if ((info.mode & 0o070) !== 0) {
        const readers = await groupReaders(info.gid);
        const allowed = entitled.get(path) ?? new Set<string>();
        const extra = readers.filter((reader) => !allowed.has(reader));
        if (extra.length > 0) {
          exposed.push(`${path} (mode ${mode}, also readable by ${extra.join(', ')})`);
        }
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
      detail: `${exposed.length} secret file(s) are readable by an identity their unit does not name, which is the whole reason for passing paths instead of values.`,
      observed,
    };
  }
  return {
    status: 'satisfied',
    detail: `All ${referenced.length} unit-referenced secret files exist and are readable by no identity beyond the unit that names them.`,
    observed,
  };
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
