/**
 * A read-only git source reader.
 *
 * `LamQuant` owns 164 decision records, its specifications and its benches; `openhuman-quality`
 * owns the QMS. This is how the Fabric reads them: `git cat-file`, at a pinned commit, and
 * nothing else.
 *
 * Read-only is structural rather than promised. There is one command in this file, it is
 * `cat-file`, and the arguments are a validated commit sha and a path. No shell is involved —
 * `execFile` takes an argument vector — so a path containing a semicolon is a path, not a
 * second command.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SourceReader } from './federation.js';

const run = promisify(execFile);

const COMMIT = /^[0-9a-f]{40}$/;

export class GitReadFailed extends Error {
  readonly reason: 'not_a_repository' | 'bad_commit' | 'refused_path';

  constructor(reason: GitReadFailed['reason'], message: string) {
    super(message);
    this.name = 'GitReadFailed';
    this.reason = reason;
  }
}

export interface GitSourceOptions {
  /** Path to a checkout or a bare clone. */
  readonly repositoryPath: string;
  /** Bytes above which a blob is refused rather than buffered. */
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Reads blobs from a git repository at a pinned commit.
 *
 * Every guard here exists because the input is a path and a sha that came from somewhere
 * else, and this process has a filesystem.
 */
export class GitSourceReader implements SourceReader {
  readonly #repository: string;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;

  constructor(options: GitSourceOptions) {
    this.#repository = options.repositoryPath;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async read(commitSha: string, path: string): Promise<Buffer | undefined> {
    if (!COMMIT.test(commitSha)) {
      // The federation layer refuses a branch too, but this is the boundary that touches a
      // filesystem, so it does not rely on being called correctly.
      throw new GitReadFailed(
        'bad_commit',
        `refusing to read at '${commitSha}': a full 40-character sha, or nothing`,
      );
    }
    assertReadablePath(path);

    try {
      const { stdout } = await run('git', ['cat-file', 'blob', `${commitSha}:${path}`], {
        cwd: this.#repository,
        // Buffer, not a string: a decision record is text, but a diagram is not, and decoding
        // a PNG as UTF-8 would change the bytes the digest is taken over.
        encoding: 'buffer',
        maxBuffer: this.#maxBytes,
        timeout: this.#timeoutMs,
        // No shell. The path is an argument, not a fragment of a command line.
        shell: false,
      });
      return stdout;
    } catch (err: unknown) {
      const e = err as { stderr?: Buffer | string; code?: string | number; killed?: boolean };
      const stderr = String(e.stderr ?? '');

      // "Not a valid object name" is the ordinary answer to "is this file there at that
      // commit", and callers treat undefined as exactly that.
      if (/not a valid object name|does not exist|Not a valid object/i.test(stderr)) {
        return undefined;
      }
      if (/not a git repository/i.test(stderr)) {
        throw new GitReadFailed('not_a_repository', `${this.#repository} is not a git repository`);
      }
      throw err;
    }
  }
}

/**
 * Refuse paths that are not paths inside the tree.
 *
 * `git cat-file blob <sha>:<path>` resolves against the commit's tree, so `../` cannot escape
 * to the filesystem — but it can escape the SUBTREE somebody thought they had scoped a reader
 * to, and a leading `/` or a `:` changes how git parses the whole revision expression. All
 * three are refused rather than reasoned about.
 */
function assertReadablePath(path: string): void {
  if (path === '' || path.startsWith('/')) {
    throw new GitReadFailed('refused_path', `refusing an absolute or empty path: '${path}'`);
  }
  if (path.split('/').includes('..')) {
    throw new GitReadFailed('refused_path', `refusing a path with a parent segment: '${path}'`);
  }
  if (path.includes(':')) {
    // A colon is what separates the revision from the path; one inside the path would make
    // this a different expression than it reads as.
    throw new GitReadFailed('refused_path', `refusing a path containing a colon: '${path}'`);
  }
  if (path.includes('\0')) {
    throw new GitReadFailed('refused_path', 'refusing a path containing a null byte');
  }
}
