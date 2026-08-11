/**
 * The git reader, against a real repository.
 *
 * Two things matter here and neither is "it reads files". The reader touches a filesystem
 * with a path that came from somewhere else, and it is the boundary where a citation stops
 * being data and starts being an argument to a command.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitReadFailed, GitSourceReader, digestOf } from './index.js';

let repo: string;
let commit: string;
let reader: GitSourceReader;

const ADR = '# ADR 0139 — unify around ABIR\n\nStatus: accepted.\n';

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'kf-git-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  git('init', '--quiet', '--initial-branch', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');

  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'decisions', 'adr-0139.md'), ADR, 'utf8');
  // A binary file, to prove the reader does not decode what it reads.
  writeFileSync(join(repo, 'docs', 'diagram.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]));
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');
  commit = git('rev-parse', 'HEAD');

  reader = new GitSourceReader({ repositoryPath: repo });
});

afterAll(() => {
  if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
});

describe('reading at a pinned commit', () => {
  it('returns the bytes exactly', async () => {
    const bytes = await reader.read(commit, 'docs/decisions/adr-0139.md');
    expect(bytes?.toString('utf8')).toBe(ADR);
    expect(digestOf(bytes!)).toBe(digestOf(ADR));
  });

  it('does not decode binary content', async () => {
    // Decoding a diagram as UTF-8 would change the bytes the digest is taken over, which
    // would make every citation of it wrong in a way nobody would notice.
    const bytes = await reader.read(commit, 'docs/diagram.bin');
    expect([...bytes!]).toEqual([0xff, 0xfe, 0x00, 0x80, 0x41]);
  });

  it('returns undefined for a file that is not there', async () => {
    // The ordinary answer to "is this at that commit", not an error.
    expect(await reader.read(commit, 'docs/decisions/adr-9999.md')).toBeUndefined();
  });

  it('reads the content AT THAT COMMIT, not the working tree', async () => {
    writeFileSync(join(repo, 'docs', 'decisions', 'adr-0139.md'), '# Changed on disk\n', 'utf8');
    const bytes = await reader.read(commit, 'docs/decisions/adr-0139.md');
    // The whole reason citations are pinned: what the file says today is a different fact
    // from what it said when somebody cited it.
    expect(bytes?.toString('utf8')).toBe(ADR);
  });
});

describe('what it refuses', () => {
  it('refuses a branch name', async () => {
    const err = await reader.read('main', 'docs/decisions/adr-0139.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitReadFailed);
    expect((err as GitReadFailed).reason).toBe('bad_commit');
  });

  it('refuses a short sha', async () => {
    const err = await reader
      .read(commit.slice(0, 12), 'docs/decisions/adr-0139.md')
      .catch((e: unknown) => e);
    expect((err as GitReadFailed).reason).toBe('bad_commit');
  });

  it('refuses a parent segment', async () => {
    // Cannot escape to the filesystem — git resolves against the tree — but it CAN escape a
    // subtree somebody thought they had scoped a reader to.
    const err = await reader.read(commit, 'docs/../docs/diagram.bin').catch((e: unknown) => e);
    expect((err as GitReadFailed).reason).toBe('refused_path');
  });

  it('refuses an absolute path, an empty one, and a colon', async () => {
    for (const path of ['/etc/passwd', '', 'docs:decisions/adr.md']) {
      const err = await reader.read(commit, path).catch((e: unknown) => e);
      expect((err as GitReadFailed).reason, path).toBe('refused_path');
    }
  });

  it('treats a path with shell metacharacters as a path', async () => {
    // No shell is involved, so this is a filename that does not exist rather than a second
    // command. Undefined, not an execution.
    expect(await reader.read(commit, 'docs/x; rm -rf /.md')).toBeUndefined();
  });

  it('reports a directory that is not a repository', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'kf-notgit-'));
    try {
      const bare = new GitSourceReader({ repositoryPath: notRepo });
      const err = await bare.read(commit, 'anything.md').catch((e: unknown) => e);
      expect((err as GitReadFailed).reason).toBe('not_a_repository');
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
