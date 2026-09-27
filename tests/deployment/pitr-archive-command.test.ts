/**
 * KF-SAS-RQ-166: an archiving command SHALL fail on a write it did not perform, and SHALL NOT
 * report success for a skipped file.
 *
 * `deploy/postgres/pitr.conf` explains in a comment why its archive command is
 * `test ! -f <dest> && cp <src> <dest>` and not `cp -n`: `cp -n` exits 0 when it skips, which
 * tells PostgreSQL a segment was archived when it was not. A comment is not a gate — the line
 * under it is one keystroke from `cp -n`, and that edit reads as a simplification.
 *
 * So this runs the shipped command the way PostgreSQL does: `%p` and `%f` substituted, through
 * `sh -c`, twice for the same WAL name. PostgreSQL reuses segment names after a timeline change,
 * so the second run is not hypothetical — it is the case that destroys the archive.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const PITR = join(ROOT, 'deploy', 'postgres', 'pitr.conf');
const ARCHIVE_DIR = '/srv/kf-wal';

/** The value of `archive_command`, unquoted as postgresql.conf does ('' is a literal quote). */
function archiveCommand(conf: string): string {
  const lines = conf
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^archive_command\s*=/.test(line));
  expect(lines, 'pitr.conf must set archive_command exactly once').toHaveLength(1);
  const match = /^archive_command\s*=\s*'((?:[^']|'')*)'\s*(#.*)?$/.exec(lines[0]!);
  expect(match, 'archive_command is not a single-quoted string').not.toBeNull();
  return match![1]!.replace(/''/g, "'");
}

/** PostgreSQL's substitution: %p the path, %f the file name, %% a literal percent. */
function substitute(command: string, path: string, file: string): string {
  return command.replace(/%[pf%]/g, (token) =>
    token === '%p' ? path : token === '%f' ? file : '%',
  );
}

function runArchive(command: string, dir: string, source: string, name: string) {
  return spawnSync('sh', ['-c', substitute(command, source, name)], {
    cwd: dir,
    encoding: 'utf8',
  });
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the command twice for one WAL name with different content, against a scratch archive.
 * Returns both exit statuses and what the archive holds afterwards.
 */
function archiveTwice(command: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kf-pitr-'));
  scratch.push(dir);
  const archive = join(dir, 'archive');
  mkdirSync(archive);
  // Only the destination moves; the command itself is exactly what ships.
  expect(command, `the archive command no longer writes to ${ARCHIVE_DIR}`).toContain(ARCHIVE_DIR);
  const local = command.split(ARCHIVE_DIR).join(archive);

  const name = '000000010000000000000001';
  writeFileSync(join(dir, 'first'), 'timeline 1\n');
  writeFileSync(join(dir, 'second'), 'timeline 2 reuses the name\n');
  const first = runArchive(local, dir, 'first', name);
  const second = runArchive(local, dir, 'second', name);
  return {
    first: first.status,
    second: second.status,
    archived: readFileSync(join(archive, name), 'utf8'),
  };
}

/** What is wrong with a command's behaviour on a reused WAL name, in words; empty if nothing. */
function violations(result: ReturnType<typeof archiveTwice>): string[] {
  const found: string[] = [];
  if (result.first !== 0) found.push('the first archive of a new segment failed');
  if (result.second === 0) {
    found.push('a second archive of the same WAL name reported success');
  }
  if (result.archived !== 'timeline 1\n')
    found.push('the second run overwrote the archived segment');
  return found;
}

describe('the WAL archive command never overwrites and never lies (KF-SAS-RQ-166)', () => {
  it('the shipped command archives a new segment, and fails without writing on a reused name', () => {
    const shipped = archiveCommand(readFileSync(PITR, 'utf8'));
    expect(
      violations(archiveTwice(shipped)),
      'PostgreSQL recycles a segment it was told was archived; a command that skips or ' +
        'overwrites and exits 0 leaves a hole no restore can cross',
    ).toEqual([]);
  });

  // The self-tests. A harness that passes every command proves nothing, so each way of getting
  // this wrong is planted and must be caught. (`cp -n` is the one the config warns about, and is
  // deliberately NOT planted: its exit status on a skip changed across coreutils 9.2-9.5, so a
  // self-test on it would pass or fail by host. These two lie the same way on every host.)
  it.each([
    ['skips and reports success', `test -f ${ARCHIVE_DIR}/%f || cp %p ${ARCHIVE_DIR}/%f`],
    ['overwrites and reports success', `cp %p ${ARCHIVE_DIR}/%f`],
  ])('the harness catches a command that %s', (_label, command) => {
    expect(violations(archiveTwice(command))).not.toEqual([]);
  });
});
