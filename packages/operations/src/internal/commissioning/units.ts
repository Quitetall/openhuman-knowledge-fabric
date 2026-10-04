import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import type { CommissioningCheckFn, CommissioningInputs } from './contracts.js';
import { readUnitCompositions, reviewedDropIns, type UnitFragment } from './unit-composition.js';
import { commissioningDirectives } from './unit-directives.js';
import { observeSecretFile, secretAccounts, secretFileVerdict } from './secret-files.js';
import {
  observePublicConfiguration,
  publicConfigurationCatalog,
  publicConfigurationRole,
  publicConfigurationVerdict,
} from './public-configuration.js';

/** One systemd unit, reduced to the directives commissioning cares about. */
export interface UnitFacts {
  readonly name: string;
  readonly user: string | null;
  readonly onFailure: string | null;
  /** Secret candidates, excluding only enumerated public EnvironmentFiles and the API projection. */
  readonly secretPaths: readonly string[];
  readonly secretSources: readonly {
    readonly path: string;
    readonly kind: 'direct' | 'pid1-source' | 'encrypted-pid1-source';
    readonly credential?: string;
  }[];
  readonly publicConfigurationPaths: readonly string[];
  readonly digest: string;
  /** Exact base bytes and selected drop-ins, present when read from a declared directory. */
  readonly baseDigest?: string;
  readonly dropIns?: readonly UnitFragment[];
}

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
  const secretSources: UnitFacts['secretSources'][number][] = [];
  const publicConfigurationPaths = new Set<string>();
  const addSecret = (
    path: string,
    kind: UnitFacts['secretSources'][number]['kind'] = 'direct',
    credential?: string,
  ) => {
    secretPaths.add(path);
    if (
      !secretSources.some(
        (source) =>
          source.path === path && source.kind === kind && source.credential === credential,
      )
    ) {
      secretSources.push({ path, kind, ...(credential === undefined ? {} : { credential }) });
    }
  };

  for (const [key, value] of commissioningDirectives(text)) {
    if (key === 'User') user = value;
    else if (key === 'OnFailure') onFailure = [onFailure, value].filter(Boolean).join(' ');
    else if (key === 'EnvironmentFile') {
      const path = value.replace(/^-/, '');
      if (publicConfigurationRole(name, path) !== null) publicConfigurationPaths.add(path);
      else addSecret(path);
    }
    // `LoadCredentialEncrypted=<id>:<path>` names a credential only its own unit receives —
    // the restore drill's backup-decryption key. Counted as a secret so that two units sharing
    // a uid, only one of which names it, show up as the surplus they are.
    else if (key === 'LoadCredentialEncrypted' || key === 'LoadCredential') {
      const path = value.slice(value.indexOf(':') + 1);
      if (value.includes(':') && path.startsWith('/'))
        addSecret(
          path,
          key === 'LoadCredential' ? 'pid1-source' : 'encrypted-pid1-source',
          value.slice(0, value.indexOf(':')),
        );
    }
    // `Environment=`, `ExecStart=` and `ExecStartPre=` all carry `*_FILE=` assignments in the
    // shipped units, because the deployment passes secrets as paths rather than as values.
    // Scanning the whole line rather than a fixed directive list means a secret moved from
    // `Environment=` into the command still gets checked.
    for (const match of value.matchAll(SECRET_ASSIGNMENT)) {
      const [, name, path] = match;
      if (name === undefined || path === undefined) continue;
      if (NOT_A_SECRET.test(name)) continue;
      addSecret(path);
    }
    for (const match of value.matchAll(SECRET_PRESENCE_TEST)) {
      const path = match[1];
      if (
        path !== undefined &&
        !(
          name === 'kf-api.service' &&
          path === '/opt/kf/generated/projections/knowledge-fabric.projections.json'
        )
      )
        addSecret(path);
    }
  }

  return {
    name,
    user,
    onFailure,
    secretPaths: [...secretPaths].sort(),
    secretSources,
    publicConfigurationPaths: [...publicConfigurationPaths].sort(),
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
  return (await readUnitCompositions(directory, only)).map((composition) => ({
    ...parseUnit(composition.name, composition.text),
    baseDigest: composition.baseDigest,
    dropIns: composition.dropIns,
  }));
}

/**
 * What an operator runs next. Every file these checks find missing is one the provisioning
 * command creates or names — generated secrets it makes, the rest it lists with their paths —
 * so a failure says where to go rather than only what is wrong.
 */
export const PROVISION_HINT =
  'Run `sudo /opt/kf/scripts/deploy/provision-host.sh --check` to list every missing file and ' +
  'the inputs only a person can supply; `sudo /opt/kf/scripts/deploy/provision-host.sh` ' +
  'creates the rest.';

/** The unit names this release ships, which is the entire scope of every check here. */
async function shippedNames(directory: string): Promise<ReadonlySet<string>> {
  const entries = await readdir(directory);
  return new Set(entries.filter((entry) => entry.endsWith('.service')));
}

/**
 * Compare declared installed base files and selected drop-ins with this release.
 * This filesystem check does not establish loaded PID1 state, other load paths or startup.
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
  const altered: string[] = [];
  for (const unit of shipped) {
    const actual = byName.get(unit.name);
    if (actual === undefined) continue;
    if (
      actual.baseDigest !== unit.baseDigest ||
      !(await reviewedDropIns(unit.name, actual.dropIns ?? [], inputs.shippedUnitDirectory))
    ) {
      altered.push(unit.name);
    }
  }

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
        `Installed unit file composition is not this release's reviewed configuration: ${missing.length} missing, ${altered.length} altered. ` +
        'Identity and alerting claims cannot rely on an unreviewed file composition. ' +
        PROVISION_HINT,
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
      `All ${shipped.length} installed base files match this release byte-identically, with only exact role-specific reviewed drop-ins. ` +
      `The composed files declare separate API (${observed.apiUser}) and checkpoint (${observed.checkpointUser}) identities, ` +
      'no surplus named secret paths for shared identities, and failure routing outside the alert path. ' +
      'This is file-composition evidence, not proof of loaded PID1 state or successful startup.',
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
async function readerIndex(
  inputs: Pick<CommissioningInputs, 'passwdPath' | 'groupPath'>,
): Promise<ReadonlyMap<number, readonly string[]>> {
  const [groupFile, passwdFile] = await Promise.all([
    readFile(inputs.groupPath, 'utf8'),
    readFile(inputs.passwdPath, 'utf8'),
  ]);

  const byGid = new Map<number, Set<string>>();
  const add = (gid: number, name: string): void => {
    const readers = byGid.get(gid) ?? new Set<string>();
    readers.add(name);
    byGid.set(gid, readers);
  };

  for (const line of groupFile.split('\n')) {
    const [, , id, members] = line.split(':');
    if (id === undefined) continue;
    const gid = Number(id);
    if (!Number.isInteger(gid)) continue;
    for (const member of (members ?? '').split(',')) if (member !== '') add(gid, member);
  }
  for (const line of passwdFile.split('\n')) {
    const [name, , , primary] = line.split(':');
    if (name === undefined || primary === undefined) continue;
    const gid = Number(primary);
    if (Number.isInteger(gid)) add(gid, name);
  }

  return new Map([...byGid].map(([gid, readers]) => [gid, [...readers].sort()]));
}

/**
 * Point-in-time file metadata and local account-file posture, not consumer delivery.
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
 * Ownership and effective numeric POSIX ACL access are checked too. Root is an explicit
 * trusted host custodian; UID aliases are preserved. Unencrypted PID1 sources require root
 * custody, not service ownership. Public native EnvironmentFiles have a separate closed
 * content contract. This does not prove live credentials, NSS identities or future path custody.
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
  if (referenced.length > 256)
    return {
      status: 'unverifiable',
      detail: 'Secret-source inventory exceeds the bounded commissioning scope.',
    };
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
  //
  // THE UNIT FILES DECIDE THIS, so whoever controls them controls the verdict: a unit planted
  // with `User=mallory` would entitle mallory to read mallory's group's files. That is not a
  // hole so much as the boundary this check sits inside, and it is held by `unit_provenance`,
  // which refuses to pass unless every installed unit is byte-identical to the one this
  // release ships. The two checks are only jointly meaningful — a host where
  // `unit_provenance` fails has no business reading a `secret_posture` pass as reassurance,
  // which is why `assessCommissioning` requires all eight rather than counting them.
  const entitled = new Map<string, Set<string>>();
  for (const unit of installed) {
    for (const path of unit.secretPaths) {
      const users = entitled.get(path) ?? new Set<string>();
      if (unit.user !== null) users.add(unit.user);
      entitled.set(path, users);
    }
  }

  let accounts;
  try {
    accounts = await secretAccounts(inputs);
  } catch {
    return {
      status: 'unverifiable',
      detail: 'Local account identities could not be established; no file posture is claimed.',
    };
  }
  const absent: string[] = [];
  const exposed: string[] = [];
  const observer = inputs.secretFileObservation ?? observeSecretFile;
  for (const path of referenced) {
    try {
      // Unencrypted LoadCredential sources belong to the trusted PID1 custodian, not the
      // service's volatile credential mount. Neither this nor mode 0400 proves delivery.
      const pid1Only = installed
        .flatMap((unit) => unit.secretSources)
        .filter((source) => source.path === path)
        .every((source) => source.kind === 'pid1-source');
      const result = secretFileVerdict(
        await observer(path),
        accounts,
        pid1Only ? new Set<string>() : (entitled.get(path) ?? new Set<string>()),
      );
      if (result.status === 'unverifiable') absent.push(`${path} (${result.reason})`);
      else if (result.status === 'unsatisfied') exposed.push(`${path} (${result.reason})`);
    } catch {
      absent.push(`${path} (metadata observation unavailable)`);
    }
  }
  const publicFiles = installed.flatMap((unit) =>
    unit.publicConfigurationPaths.map((path) => ({ unit: unit.name, path })),
  );
  if (publicFiles.length) {
    try {
      const catalog = await publicConfigurationCatalog(inputs.shippedUnitDirectory);
      for (const { unit, path } of publicFiles) {
        const role = publicConfigurationRole(unit, path);
        if (role === null) throw new Error('public contract unavailable');
        try {
          const result = publicConfigurationVerdict(
            await (inputs.publicFileObservation ?? observePublicConfiguration)(path),
            role,
            catalog,
          );
          if (result.status === 'unverifiable') absent.push(`${path} (${result.reason})`);
          else if (result.status === 'unsatisfied') exposed.push(`${path} (${result.reason})`);
        } catch {
          absent.push(`${path} (public configuration observation unavailable)`);
        }
      }
    } catch {
      absent.push('public configuration catalog unavailable');
    }
  }
  const observed = {
    secretPaths: referenced.length,
    directSources: installed
      .flatMap((unit) => unit.secretSources)
      .filter((source) => source.kind === 'direct').length,
    pid1Sources: installed
      .flatMap((unit) => unit.secretSources)
      .filter((source) => source.kind !== 'direct').length,
    publicConfigurations: publicFiles.length,
    absent: absent.join('; ') || 'none',
    groupOrWorldReadable: exposed.join('; ') || 'none',
  };
  if (absent.length > 0)
    return {
      status: 'unverifiable',
      detail: `${absent.length} referenced file(s) cannot be verified, so their posture is unknown. ${PROVISION_HINT}`,
      observed,
    };
  if (exposed.length > 0)
    return {
      status: 'unsatisfied',
      detail: `${exposed.length} referenced file(s) have unsafe metadata or access by an identity their unit does not name (root is the trusted custodian).`,
      observed,
    };
  return {
    status: 'satisfied',
    detail: `All ${referenced.length} secret sources and ${publicFiles.length} closed public configurations passed metadata and local account-file checks; not live credential delivery, startup, rotation or reboot evidence.`,
    observed,
  };
};

/** Account names by uid, from the passwd database. */
async function namesByUid(
  inputs: Pick<CommissioningInputs, 'passwdPath'>,
): Promise<ReadonlyMap<number, string>> {
  const byUid = new Map<number, string>();
  for (const line of (await readFile(inputs.passwdPath, 'utf8')).split('\n')) {
    const [name, , id] = line.split(':');
    const uid = Number(id);
    if (name !== undefined && name !== '' && Number.isInteger(uid)) byUid.set(uid, name);
  }
  return byUid;
}

/**
 * kf-attestor is a separate identity, reachable by kf-api alone, holding a credential kf-api
 * cannot read (20260924001000).
 *
 * The database binds a person for the API's login only on an attestation, and only
 * `kf_attestor` may issue one. That separation is worth exactly as much as the host keeps it:
 * an API user who can read the attestor's database credential, or who runs as the attestor,
 * can attest to anybody it likes, and the whole arrangement is decoration. So, on the host:
 *
 *   - kf-attestor.service is installed and runs as a different user from kf-api.service;
 *   - its socket exists, is a socket, is owned by that user, is closed to "other", and the
 *     group it is open to holds kf-api and nobody but the two of them;
 *   - no secret the attestor unit names is readable by kf-api — as owner, group or world.
 *
 * `secret_posture` additionally checks ownership, aliases and effective ACL readers. This
 * check binds the specific attestor/API socket relationship; it is not a substitute for it.
 */
export const attestorSeparation: CommissioningCheckFn = async (inputs: CommissioningInputs) => {
  let installed: readonly UnitFacts[];
  try {
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
  const api = installed.find((unit) => unit.name === 'kf-api.service');
  const attestor = installed.find((unit) => unit.name === 'kf-attestor.service');
  const observed: Record<string, string | null> = {
    apiUser: api?.user ?? null,
    attestorUser: attestor?.user ?? null,
    socket: inputs.attestorSocketPath,
  };
  if (api?.user === undefined || api.user === null) {
    return {
      status: 'unverifiable',
      detail:
        'kf-api.service is not installed or names no User=, so there is no API identity to separate from.',
      observed,
    };
  }
  if (attestor?.user === undefined || attestor.user === null) {
    return {
      status: 'unsatisfied',
      detail:
        'kf-attestor.service is not installed or names no User=. Without it no bearer caller can ' +
        'be bound, and with it running as root nothing separates it from anybody.',
      observed,
    };
  }
  if (attestor.user === api.user) {
    return {
      status: 'unsatisfied',
      detail:
        'kf-attestor and kf-api run as the same user, so the API holds the attestor credential ' +
        'and can attest to any person itself.',
      observed,
    };
  }

  const [readersByGid, byUid] = await Promise.all([readerIndex(inputs), namesByUid(inputs)]);
  const apiUser = api.user;
  const canRead = (info: { uid: number; gid: number; mode: number }): boolean =>
    (byUid.get(info.uid) === apiUser && (info.mode & 0o400) !== 0) ||
    ((readersByGid.get(info.gid) ?? []).includes(apiUser) && (info.mode & 0o040) !== 0) ||
    (info.mode & 0o004) !== 0;

  let socket;
  try {
    socket = await lstat(inputs.attestorSocketPath);
  } catch (error: unknown) {
    return {
      status: 'unverifiable',
      detail:
        `kf-attestor's socket cannot be inspected (${message(error)}). Is kf-attestor.service ` +
        'running? Nothing can be bound until it is.',
      observed,
    };
  }
  const socketReaders = readersByGid.get(socket.gid) ?? [];
  observed['socketMode'] = (socket.mode & 0o777).toString(8).padStart(3, '0');
  observed['socketOwner'] = byUid.get(socket.uid) ?? String(socket.uid);
  observed['socketGroupMembers'] = socketReaders.join(', ') || 'none';
  const socketProblems: string[] = [];
  if (!socket.isSocket()) socketProblems.push('is not a socket');
  if ((socket.mode & 0o007) !== 0) socketProblems.push('is open to every account on the host');
  if (byUid.get(socket.uid) !== attestor.user) {
    socketProblems.push(`is not owned by ${attestor.user}`);
  }
  if (!socketReaders.includes(apiUser)) {
    socketProblems.push(`is in a group ${apiUser} is not a member of, so the API cannot reach it`);
  }
  const strangers = socketReaders.filter(
    (reader) => reader !== apiUser && reader !== attestor.user,
  );
  if (strangers.length > 0) {
    socketProblems.push(`is also reachable by ${strangers.join(', ')}`);
  }

  const exposed: string[] = [];
  const absent: string[] = [];
  for (const path of attestor.secretPaths) {
    try {
      if (canRead(await stat(path))) exposed.push(path);
    } catch (error: unknown) {
      absent.push(`${path} (${message(error)})`);
    }
  }
  observed['credentialsReadableByApi'] = exposed.join(', ') || 'none';
  observed['credentialsUninspectable'] = absent.join('; ') || 'none';

  if (socketProblems.length > 0 || exposed.length > 0) {
    return {
      status: 'unsatisfied',
      detail: [
        socketProblems.length > 0 ? `The attestor socket ${socketProblems.join(', ')}.` : '',
        exposed.length > 0
          ? `${apiUser} can read the attestor's ${exposed.join(', ')}, and with it attest to anybody.`
          : '',
      ]
        .filter((part) => part !== '')
        .join(' '),
      observed,
    };
  }
  if (absent.length > 0) {
    return {
      status: 'unverifiable',
      detail: `${absent.length} secret file(s) kf-attestor names cannot be inspected.`,
      observed,
    };
  }
  return {
    status: 'satisfied',
    detail:
      `kf-attestor runs as ${attestor.user}, apart from the API (${apiUser}); its socket is ` +
      `reachable by ${apiUser} and closed to everybody else; ${apiUser} can read none of its ` +
      `${attestor.secretPaths.length} secret file(s).`,
    observed,
  };
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
