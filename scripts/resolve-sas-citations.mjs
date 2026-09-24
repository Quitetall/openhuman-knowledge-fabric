#!/usr/bin/env node
/**
 * Resolve `KF-SAS-RQ-nnn` citations against this repository's normative projection.
 *
 * KF-SAS-RQ-184: a requirement cited from another repository SHOULD be resolvable against the
 * specification by a tool, and until it is, the citation is an unverified claim (SAS §100.12).
 * This is that tool. Point it at a file or a directory — another repository's Warrants, an ADR
 * tree, a README — and it reports every citation that names no requirement.
 *
 *   node scripts/resolve-sas-citations.mjs [options] <path>...
 *
 *     --projection <file>   NORMATIVE.json to resolve against
 *                           (default: docs/sas/generated/NORMATIVE.json beside this script)
 *     --revisions <dir>     revision records, for recognising retired identifiers
 *                           (default: docs/sas/revisions beside this script)
 *     --json                one JSON report on stdout instead of lines
 *     --allow-none          exit 0 when the paths contain no citation at all
 *
 * A citation is `KF-SAS-RQ-<digits>`, bare or as `sas://KF-SAS-RQ-<digits>`. It is:
 *
 *   resolved    the projection states that requirement;
 *   retired     a revision record once listed it and the projection no longer does. §97.2 says
 *               this never happens — identifiers are append-only — so a retired citation is
 *               reported loudly, but it did once mean something and is not an invention;
 *   unresolved  no revision and no projection has ever held it: the citation names nothing.
 *
 * Exit status: 0 every citation resolved (retired ones are reported, not fatal); 1 at least one
 * unresolved; 2 a usage error or an unreadable projection; 3 no citation found at all, unless
 * --allow-none. The last is deliberate: a gate that compared nothing does not report success
 * (KF-SAS-RQ-013), and a typo in the path argument must not read as "all citations resolve".
 *
 * What this cannot tell you: whether the cited requirement SAYS what the citing text claims. It
 * resolves the reference; reading the sentence is review. It also resolves against whatever
 * revision the projection was compiled from — the report names that revision and digest, so a
 * citation resolved against a proposed revision is visibly not resolved against an accepted one.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CITATION = /(?:sas:\/\/)?\b(KF-SAS-RQ-(\d+))\b/g;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'target', '.next', 'coverage']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;

class UsageError extends Error {}

function parseArguments(argv) {
  const options = {
    projection: join(ROOT, 'docs', 'sas', 'generated', 'NORMATIVE.json'),
    revisions: join(ROOT, 'docs', 'sas', 'revisions'),
    json: false,
    allowNone: false,
    paths: [],
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--projection' || argument === '--revisions') {
      const value = argv[++index];
      if (value === undefined) throw new UsageError(`${argument} needs a value`);
      options[argument.slice(2)] = resolve(value);
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--allow-none') {
      options.allowNone = true;
    } else if (argument === '--help' || argument === '-h') {
      throw new UsageError('usage');
    } else if (argument.startsWith('--')) {
      throw new UsageError(`unknown option ${argument}`);
    } else {
      options.paths.push(resolve(argument));
    }
  }
  if (options.paths.length === 0) throw new UsageError('name at least one file or directory');
  return options;
}

/** Every requirement id the projection states, with its revision and digest. */
function readProjection(path) {
  let projection;
  try {
    projection = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read the projection ${path}: ${error.message}`);
  }
  if (projection?.schema !== 'oh.war/sas-normative/v1' || !Array.isArray(projection.sentences)) {
    throw new UsageError(`${path} is not an oh.war/sas-normative/v1 projection`);
  }
  const stated = new Set();
  for (const entry of projection.sentences) {
    const match = /^(KF-SAS-RQ-\d+)\b/.exec(String(entry?.sentence ?? ''));
    if (match) stated.add(match[1]);
  }
  // A projection that states nothing would make every citation "unresolved" for the wrong reason.
  if (stated.size === 0) throw new UsageError(`${path} states no KF-SAS-RQ requirement`);
  return { stated, revision: projection.revision, sha256: projection.sha256 };
}

/** Every id any revision record has listed. Absent directory: nothing is known to be retired. */
function readHistoricalIdentifiers(directory) {
  const known = new Set();
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.toml'));
  } catch {
    return known;
  }
  for (const name of names) {
    for (const match of readFileSync(join(directory, name), 'utf8').matchAll(
      /^(KF-SAS-RQ-\d+)\s*=/gm,
    )) {
      known.add(match[1]);
    }
  }
  return known;
}

function* walk(path) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new UsageError(`no such file or directory: ${path}`);
  }
  if (stats.isFile()) {
    yield path;
    return;
  }
  if (!stats.isDirectory()) return;
  for (const name of readdirSync(path).sort()) {
    if (SKIP_DIRECTORIES.has(name)) continue;
    const child = join(path, name);
    const childStats = statSync(child, { throwIfNoEntry: false });
    if (childStats?.isDirectory()) yield* walk(child);
    else if (childStats?.isFile()) yield child;
  }
}

function citationsIn(file) {
  if (statSync(file).size > MAX_FILE_BYTES) return [];
  const bytes = readFileSync(file);
  if (bytes.includes(0)) return [];
  const found = [];
  bytes
    .toString('utf8')
    .split('\n')
    .forEach((line, index) => {
      for (const match of line.matchAll(CITATION)) {
        found.push({ id: match[1], line: index + 1 });
      }
    });
  return found;
}

function main(argv) {
  const options = parseArguments(argv);
  const projection = readProjection(options.projection);
  const historical = readHistoricalIdentifiers(options.revisions);

  const citations = [];
  for (const root of options.paths) {
    for (const file of walk(root)) {
      for (const citation of citationsIn(file)) {
        const status = projection.stated.has(citation.id)
          ? 'resolved'
          : historical.has(citation.id)
            ? 'retired'
            : 'unresolved';
        citations.push({ file: relative(process.cwd(), file) || file, ...citation, status });
      }
    }
  }

  const count = (status) => citations.filter((citation) => citation.status === status).length;
  const summary = {
    schema: 'kf/sas-citation-report/v1',
    projection: { revision: projection.revision, sha256: projection.sha256 },
    citations: citations.length,
    resolved: count('resolved'),
    retired: count('retired'),
    unresolved: count('unresolved'),
  };
  const exitCode =
    summary.unresolved > 0 ? 1 : summary.citations === 0 && !options.allowNone ? 3 : 0;

  if (options.json) {
    const problems = citations.filter((citation) => citation.status !== 'resolved');
    process.stdout.write(`${JSON.stringify({ ...summary, problems, exit_code: exitCode })}\n`);
  } else {
    for (const citation of citations) {
      if (citation.status === 'resolved') continue;
      process.stdout.write(
        `${citation.file}:${citation.line}: ${citation.id} ${citation.status}\n`,
      );
    }
    process.stdout.write(
      `${summary.citations} citation(s) against revision ${projection.revision} ` +
        `(sha256:${String(projection.sha256).slice(0, 12)}): ${summary.resolved} resolved, ` +
        `${summary.retired} retired, ${summary.unresolved} unresolved\n`,
    );
    if (exitCode === 3) {
      process.stderr.write(
        'resolve-sas-citations: no citation found; a check that compared nothing is not a pass ' +
          '(pass --allow-none if that is expected)\n',
      );
    }
  }
  return exitCode;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  process.stderr.write(
    error.message === 'usage'
      ? 'usage: resolve-sas-citations.mjs [--projection f] [--revisions d] [--json] [--allow-none] <path>...\n'
      : `resolve-sas-citations: ${error.message}\n`,
  );
  process.exitCode = 2;
}
