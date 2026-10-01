#!/usr/bin/env node
/**
 * Close the host across database recovery, including PITR (KF-SAS §100.29).
 * Persistent start guards survive reboot; neither hold nor a failed recovery resumes serving.
 * The operator declares every external retrieval/cache holder, locally or on each peer host.
 * This coordinates processes, not backup verification or institutional release acceptance.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = ['kf-api.service', 'kf-worker.service'];
const GUARD = '90-kf-recovery.conf';

function directory(path, uid) {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o755 });
    syncDirectory(dirname(path));
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & 0o022) {
    throw new Error('recovery directory is not owner-controlled');
  }
}

function regular(path, uid) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    stat.mode & 0o022 ||
    stat.nlink !== 1 ||
    stat.size > 65536
  ) {
    throw new Error('recovery file is not owner-controlled');
  }
  return readFileSync(path, 'utf8');
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function exclusiveFile(path, body) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function units(values) {
  if (
    !Array.isArray(values) ||
    values.length > 64 ||
    values.some(
      (value) =>
        typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,119}\.service$/.test(value),
    )
  ) {
    throw new Error('invalid recovery unit list');
  }
  const result = [...new Set([...BASE, ...values])];
  if (result.length > 64) throw new Error('invalid recovery unit list');
  return result;
}

function inspect(manager, unit, requireStopped = false) {
  const result = manager([
    'show',
    unit,
    '--property=LoadState,ActiveState,MainPID,ControlPID,KillMode',
  ]);
  const fields = new Map(
    result
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  if (fields.get('LoadState') !== 'loaded') throw new Error(`recovery unit not loaded: ${unit}`);
  if (fields.get('KillMode') !== 'control-group')
    throw new Error(`recovery requires control-group stopping: ${unit}`);
  if (
    requireStopped &&
    (!['inactive', 'failed'].includes(fields.get('ActiveState')) ||
      fields.get('MainPID') !== '0' ||
      fields.get('ControlPID') !== '0')
  ) {
    throw new Error(`recovery unit not stopped: ${unit}`);
  }
}

function guardBody(stateDirectory) {
  // The manager checks the condition as root, including when the service identity cannot
  // traverse the state directory. A negative `test -e` alone treats EACCES as absence.
  return `[Unit]\nConditionPathExists=!${stateDirectory}/held\n[Service]\n# Persistent recovery interlock; never remove to bypass an incomplete recovery.\nExecStartPre=/usr/bin/test ! -e ${stateDirectory}/held\n`;
}

/** Hold every declared cache holder, or resume fresh processes after verified recovery. */
export function recoveryBarrier(
  command,
  additionalUnits,
  { stateDirectory, unitDirectory, ownerUid, manager },
) {
  if (!['hold', 'resume-confirmed'].includes(command)) throw new Error('unknown recovery command');
  if (command === 'resume-confirmed' && additionalUnits.length)
    throw new Error('resume uses the held unit list');
  // The production entry point fixes these paths; reject characters that could change a unit directive.
  for (const path of [stateDirectory, unitDirectory]) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').includes('..'))
      throw new Error('unsafe recovery path');
    directory(path, ownerUid);
  }
  const lock = join(stateDirectory, 'operation.lock');
  const lockFd = openSync(
    lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const held = join(stateDirectory, 'held');
    let holders = units(additionalUnits);
    if (existsSync(held)) {
      const record = JSON.parse(regular(held, ownerUid));
      if (record.format !== 'kf-recovery-barrier/v1') throw new Error('invalid recovery hold');
      const recorded = units(record.units);
      if (JSON.stringify(recorded) !== JSON.stringify(record.units))
        throw new Error('invalid held unit list');
      // Changing the list during recovery could forget a process with a surviving cache.
      if (additionalUnits.some((unit) => !recorded.includes(unit)))
        throw new Error('cannot extend an existing recovery hold');
      holders = recorded;
    } else if (command === 'resume-confirmed') {
      throw new Error('no recovery hold exists');
    }
    for (const unit of holders) inspect(manager, unit, command === 'resume-confirmed');
    const body = guardBody(stateDirectory);
    if (command === 'hold') {
      if (!existsSync(held)) {
        exclusiveFile(
          held,
          `${JSON.stringify({ format: 'kf-recovery-barrier/v1', units: holders })}\n`,
        );
        syncDirectory(stateDirectory);
      }
      for (const unit of holders) {
        const dropin = join(unitDirectory, `${unit}.d`);
        directory(dropin, ownerUid);
        const path = join(dropin, GUARD);
        if (!existsSync(path)) {
          exclusiveFile(path, body);
          syncDirectory(dropin);
        }
        if (regular(path, ownerUid) !== body)
          throw new Error('recovery guard differs; refusing overwrite');
      }
      syncDirectory(unitDirectory);
      manager(['daemon-reload']);
      manager(['stop', ...holders]);
      for (const unit of holders) inspect(manager, unit, true);
    } else {
      for (const unit of holders) {
        directory(join(unitDirectory, `${unit}.d`), ownerUid);
        if (regular(join(unitDirectory, `${unit}.d`, GUARD), ownerUid) !== body)
          throw new Error('recovery guard differs');
      }
      // Every cache holder is dead. Removing the interlock permits only fresh processes.
      unlinkSync(held);
      syncDirectory(stateDirectory);
      manager([
        'start',
        ...holders.filter((unit) => !BASE.includes(unit)),
        'kf-worker.service',
        'kf-api.service',
      ]);
    }
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.getuid?.() !== 0) throw new Error('host recovery requires root');
    const [command, ...additionalUnits] = process.argv.slice(2);
    recoveryBarrier(command, additionalUnits, {
      stateDirectory: '/var/lib/kf-recovery',
      unitDirectory: '/etc/systemd/system',
      ownerUid: 0,
      manager: (args) => {
        const result = spawnSync('/usr/bin/systemctl', args, { encoding: 'utf8', timeout: 180000 });
        if (result.error || result.status !== 0)
          throw new Error('system manager refused recovery operation');
        return result.stdout;
      },
    });
    process.stdout.write(
      (command === 'hold'
        ? 'Recovery held: serving is stopped. Verify recovery before resuming.'
        : 'Fresh processes requested. Run host preflight before reopening traffic.') + '\n',
    );
  } catch {
    console.error(
      'Recovery barrier refused or failed. Do not restore or reopen traffic; inspect the hold and stopped units locally.',
    );
    process.exitCode = 1;
  }
}
