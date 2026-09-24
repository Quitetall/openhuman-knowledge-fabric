/**
 * Atomic install and rollback (KF-SAS-RQ-162), against a temporary prefix.
 *
 * Until 2026-09-25 both existed only as prose in docs/deployment/private-host.md: "switch
 * `/opt/kf` atomically" and "keep the previous release intact". These tests run the script that
 * replaced the prose, with the real release verifier (`migrate-release.sh check`) and a release
 * tree shaped as the verifier requires, so "refuses a release that does not verify" is the
 * verifier refusing, not a stub.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const INSTALL = join(ROOT, 'scripts', 'deploy', 'install-release.sh');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function prefix(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kf-install-'));
  temporaryDirectories.push(directory);
  return directory;
}

function walk(directory: string, kind: 'file' | 'directory'): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (kind === 'directory') found.push(relative(directory, path));
        visit(path);
      } else if (kind === 'file' && entry.isFile() && entry.name !== 'SHA256SUMS') {
        found.push(relative(directory, path));
      }
    }
  };
  visit(directory);
  return found.sort();
}

/** A release the verifier accepts: migrations, seed, packaged dbmate, inventories, manifest. */
function makeRelease(root: string, name: string): { directory: string; manifest: string } {
  const directory = join(root, name);
  mkdirSync(join(directory, 'database', 'migrations'), { recursive: true });
  mkdirSync(join(directory, 'generated', 'sql-registry'), { recursive: true });
  mkdirSync(join(directory, 'tools'), { recursive: true });
  writeFileSync(
    join(directory, 'database', 'migrations', '20260814000100_example.sql'),
    '-- migrate:up\nselect 1;\n-- migrate:down\nselect 1;\n',
  );
  writeFileSync(
    join(directory, 'generated', 'sql-registry', '001-ontology-seed.sql'),
    `-- source_digest: ${'d'.repeat(64)}\nselect 1;\n`,
  );
  writeFileSync(join(directory, 'RELEASE-NAME'), `${name}\n`);
  const dbmate = join(directory, 'tools', 'dbmate');
  writeFileSync(dbmate, "#!/bin/sh\necho 'dbmate version 2.35.0'\n");
  chmodSync(dbmate, 0o755);
  writeFileSync(join(directory, 'DIRECTORIES'), `${walk(directory, 'directory').join('\n')}\n`);
  writeFileSync(join(directory, 'SYMLINKS'), '');
  const lines = walk(directory, 'file').map(
    (file) =>
      `${createHash('sha256')
        .update(readFileSync(join(directory, file)))
        .digest('hex')}  ${file}`,
  );
  writeFileSync(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  const manifest = createHash('sha256')
    .update(readFileSync(join(directory, 'SHA256SUMS')))
    .digest('hex');
  return { directory, manifest };
}

function run(root: string, args: string[], manifest?: string): { code: number; output: string } {
  const result = spawnSync('bash', [INSTALL, ...args], {
    cwd: '/',
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      KF_INSTALL_ROOT: root,
      KF_EXPECTED_DBMATE_VERSION: '2.35.0',
      KF_EXPECTED_RELEASE_OWNER_UID: String(process.getuid?.() ?? 0),
      ...(manifest === undefined ? {} : { KF_EXPECTED_RELEASE_MANIFEST_SHA256: manifest }),
    },
  });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const live = (root: string): string => readlinkSync(join(root, 'kf'));
const previous = (root: string): string | undefined =>
  existsSync(join(root, 'kf.previous')) || lstatExists(join(root, 'kf.previous'))
    ? readlinkSync(join(root, 'kf.previous'))
    : undefined;
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Each run hashes a release tree through the real verifier; generous on a loaded machine.
describe('install-release.sh', { timeout: 120_000 }, () => {
  it('installs, keeps the previous release, and rolls back and forward', () => {
    const root = prefix();
    const a = makeRelease(root, 'knowledge-fabric-aaaaaaaaaaaa');
    const b = makeRelease(root, 'knowledge-fabric-bbbbbbbbbbbb');

    const first = run(root, ['install', a.directory], a.manifest);
    expect(first.code, first.output).toBe(0);
    expect(lstatSync(join(root, 'kf')).isSymbolicLink()).toBe(true);
    expect(live(root)).toBe('knowledge-fabric-aaaaaaaaaaaa');
    expect(previous(root)).toBeUndefined();
    // Through the link, the release's own bytes: the link resolves beside it, not elsewhere.
    expect(readFileSync(join(root, 'kf', 'RELEASE-NAME'), 'utf8')).toBe(
      'knowledge-fabric-aaaaaaaaaaaa\n',
    );

    const second = run(root, ['install', b.directory], b.manifest);
    expect(second.code, second.output).toBe(0);
    expect(live(root)).toBe('knowledge-fabric-bbbbbbbbbbbb');
    expect(previous(root)).toBe('knowledge-fabric-aaaaaaaaaaaa');
    // The previous release is intact, not moved or rewritten.
    expect(readFileSync(join(a.directory, 'RELEASE-NAME'), 'utf8')).toBe(
      'knowledge-fabric-aaaaaaaaaaaa\n',
    );

    const status = run(root, ['status']);
    expect(status.output).toContain(
      `live: knowledge-fabric-bbbbbbbbbbbb manifest_sha256=${b.manifest}`,
    );
    expect(status.output).toContain(
      `previous: knowledge-fabric-aaaaaaaaaaaa manifest_sha256=${a.manifest}`,
    );

    const back = run(root, ['rollback']);
    expect(back.code, back.output).toBe(0);
    expect(live(root)).toBe('knowledge-fabric-aaaaaaaaaaaa');
    expect(previous(root)).toBe('knowledge-fabric-bbbbbbbbbbbb');

    const forward = run(root, ['rollback']);
    expect(forward.code, forward.output).toBe(0);
    expect(live(root)).toBe('knowledge-fabric-bbbbbbbbbbbb');
  });

  it('refuses a release whose manifest digest does not verify, and moves nothing', () => {
    const root = prefix();
    const a = makeRelease(root, 'knowledge-fabric-aaaaaaaaaaaa');
    const b = makeRelease(root, 'knowledge-fabric-bbbbbbbbbbbb');
    expect(run(root, ['install', a.directory], a.manifest).code).toBe(0);

    const wrong = run(root, ['install', b.directory], 'f'.repeat(64));
    expect(wrong.code).not.toBe(0);
    expect(wrong.output).toContain('release manifest checksum differs');
    expect(live(root)).toBe('knowledge-fabric-aaaaaaaaaaaa');
    expect(previous(root)).toBeUndefined();
    expect(existsSync(join(root, '.kf-install', 'knowledge-fabric-bbbbbbbbbbbb.verified'))).toBe(
      false,
    );
  });

  it('refuses a release whose bytes changed after its manifest was reviewed', () => {
    const root = prefix();
    const b = makeRelease(root, 'knowledge-fabric-bbbbbbbbbbbb');
    appendFileSync(join(b.directory, 'RELEASE-NAME'), 'tampered\n');
    const result = run(root, ['install', b.directory], b.manifest);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('checksum verification failed');
    expect(lstatExists(join(root, 'kf'))).toBe(false);
  });

  it('re-verifies the previous release before rolling back to it', () => {
    const root = prefix();
    const a = makeRelease(root, 'knowledge-fabric-aaaaaaaaaaaa');
    const b = makeRelease(root, 'knowledge-fabric-bbbbbbbbbbbb');
    expect(run(root, ['install', a.directory], a.manifest).code).toBe(0);
    expect(run(root, ['install', b.directory], b.manifest).code).toBe(0);
    appendFileSync(join(a.directory, 'RELEASE-NAME'), 'edited on the host\n');

    const result = run(root, ['rollback']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('does not verify');
    expect(live(root)).toBe('knowledge-fabric-bbbbbbbbbbbb');
    expect(previous(root)).toBe('knowledge-fabric-aaaaaaaaaaaa');
  });

  it('refuses a rollback when there is no previous release', () => {
    const root = prefix();
    const a = makeRelease(root, 'knowledge-fabric-aaaaaaaaaaaa');
    expect(run(root, ['install', a.directory], a.manifest).code).toBe(0);
    const result = run(root, ['rollback']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('no previous release');
    expect(live(root)).toBe('knowledge-fabric-aaaaaaaaaaaa');
  });

  it('refuses to replace a live path that is a real directory, or reinstall the live release', () => {
    const root = prefix();
    const a = makeRelease(root, 'knowledge-fabric-aaaaaaaaaaaa');
    mkdirSync(join(root, 'kf'));
    const handMade = run(root, ['install', a.directory], a.manifest);
    expect(handMade.code).not.toBe(0);
    expect(handMade.output).toContain('is not a symlink');
    rmSync(join(root, 'kf'), { recursive: true });

    expect(run(root, ['install', a.directory], a.manifest).code).toBe(0);
    const again = run(root, ['install', a.directory], a.manifest);
    expect(again.code).not.toBe(0);
    expect(again.output).toContain('already live');
  });

  it('refuses a release that is not directly beside the live link', () => {
    const root = prefix();
    const elsewhere = prefix();
    const a = makeRelease(elsewhere, 'knowledge-fabric-aaaaaaaaaaaa');
    const result = run(root, ['install', a.directory], a.manifest);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('must sit directly in');
  });

  it('switches the link by rename, never by unlinking it first', () => {
    // `ln -sfn` unlinks then creates: a reader between the two finds no /opt/kf at all.
    const body = readFileSync(INSTALL, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(body).toContain('mv -T -- "$temporary" "$link"');
    expect(body).not.toMatch(/ln -s?f/);
    expect(body).not.toMatch(/rm [^\n]*\$live_link/);
  });
});
