/**
 * The scanner behind `digest-tags.test.ts`: every place production source takes a SHA-256
 * that could be a structure's digest without a format tag in its preimage (KF-SAS-RQ-016).
 *
 * Three shapes are found, line by line:
 *   - `digest(` — the bare canonical digest — in a file that imports it from
 *     `@kf/canonicalization`. `taggedDigest(` is the approved form and is not matched, nor is a
 *     method call such as `hash.digest('hex')`, nor a file's own local function named `digest`.
 *   - `createHash('sha256')`, anywhere: a hash assembled by hand bypasses both helpers.
 *   - `digestBytes(Buffer.from(`: raw-byte hashing of text built in code rather than bytes
 *     received, which is how a canonical-looking digest escapes the canonical helpers.
 *
 * `@kf/canonicalization`'s own source defines these helpers and is not scanned.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DigestFinding {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

const SOURCE = /^(packages|apps)\/[^/]+\/src\/.+\.(ts|tsx|mts)$/;
const NOT_PRODUCTION = /(\.test\.tsx?$|\.test-d\.ts$|\/__tests__\/|\/test\/|\/tests\/|\.d\.ts$)/;
const DEFINITION = 'packages/canonicalization/src/index.ts';

const IMPORTS_DIGEST =
  /import\s*\{[^}]*(?<![\w$])digest(?![\w$])[^}]*\}\s*from\s*['"]@kf\/canonicalization['"]/s;
const BARE_DIGEST = /(?<![\w$.])digest\(/;
const LOCAL_DEFINITION = /function\s+digest\(/;
const CREATE_HASH = /createHash\(\s*['"]sha256['"]\s*\)/;
const BYTES_OF_TEXT = /digestBytes\(\s*Buffer\.from\(/;

/** Production TypeScript under packages/ and apps/: tracked, plus untracked and not ignored. */
export function productionSources(root: string): string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(listed.split('\0'))]
    .filter((path) => SOURCE.test(path) && !NOT_PRODUCTION.test(path) && path !== DEFINITION)
    .sort();
}

export function scanDigests(root: string, paths: readonly string[]): DigestFinding[] {
  const found: DigestFinding[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue; // listed but deleted in the working tree
    }
    const importsDigest = IMPORTS_DIGEST.test(text);
    text.split('\n').forEach((line, index) => {
      // Comment lines name these calls to explain them; they compute nothing.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const bare = importsDigest && BARE_DIGEST.test(line) && !LOCAL_DEFINITION.test(line);
      if (bare || CREATE_HASH.test(line) || BYTES_OF_TEXT.test(line)) {
        found.push({ path, line: index + 1, text: line.trim() });
      }
    });
  }
  return found;
}
