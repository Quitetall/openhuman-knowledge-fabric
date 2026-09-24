/**
 * The specification is governed by digest (KF-SAS-RQ-180) and its requirement identifiers are
 * append-only (KF-SAS-RQ-183).
 *
 * `war check` reads the revision records and reports on them, but it is not in `pnpm gate` and
 * CI did not run it, so every one of these properties was held by nobody:
 *
 *   - the document on disk is the one the newest revision recorded — otherwise an edit to the
 *     SAS silently changes the contract a proposal or an acceptance named;
 *   - an accepted revision never changes — its recorded digest matches history, and it carries a
 *     signed response or is listed as owner-pending, by name and date;
 *   - the revisions form one chain, and no identifier leaves it — §97.2: a row may be added or
 *     retitled, never removed or renumbered, because a Warrant citing it would cite nothing;
 *   - the newest revision, the §106 index and the inline requirement statements name the same
 *     set, and §106 carries no status column (§97.3: status is derived, never asserted here).
 *
 * What this cannot check: that an acceptance was really the owner's decision. A signed response
 * is the evidence for that, and signing is not an agent's act — so where it is missing this test
 * requires the gap to be written down in `docs/sas/owner-pending.json`, not closed.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SAS_PATH = 'docs/sas/KF_Software_Architecture_Specification.md';
const REVISIONS = join(ROOT, 'docs', 'sas', 'revisions');
const RESPONSES = join(ROOT, 'docs', 'authority', 'responses');
const OWNER_PENDING = join(ROOT, 'docs', 'sas', 'owner-pending.json');
const ROLES = join(ROOT, 'docs', 'authority', 'roles.toml');

/**
 * The digests accepted revisions recorded, as history fixed them. Immutability is checked against
 * THIS, not against the files alone: a revision file edited in place would agree with itself.
 * When the owner accepts a revision, its row is added here in the same change — adding a row is
 * the only edit this table ever takes.
 */
const ACCEPTED_DIGESTS: Readonly<Record<string, string>> = {
  '0.1.0-draft.1': '1a1c6f26c84f79493e7e4a30eb7199d2f0974bb0c7a3244d45f4561cf15a562b',
  '0.1.0-draft.2': '6a1ff588b3328b07e6d8bafc41e59386032059ab943a4ef9a817f34eb3e008e1',
  '0.1.0-draft.3': 'ecb95a11e5c5e48316ef7bea1ebc7ccb0cea65fbed15547ddd993948c71b6c92',
  '0.1.0-draft.4': '04573fc15f12dd010a8a110ac1ccce6f79f049bc85551821b10d54af8e71fedb',
  '0.1.0-draft.5': '84d23d16f0a9cd1e880502a67812982d75053b7d7abd890d5908c65d7e282f0d',
  '0.1.0-draft.6': '1445c75ab04570358a43531627276d36d9d12265ca00941d1bdad2cefabc6dae',
  '0.1.0-draft.7': 'cd221037a66d3b94cfdaf77215b58bc36982491a337af3d5e6ddfc65b574dd37',
};

type TomlValue = string | boolean;
type TomlTable = Record<string, TomlValue>;
type TomlDocument = Record<string, TomlTable>;

/**
 * The subset of TOML the revision, response and role files use: `[table]`, `[[array]]` headers
 * (each occurrence its own table, `name#0`, `name#1`, …), `key = "…"`, `key = """…"""`,
 * `key = true|false`, and `key = [ "a", "b" ]` (kept as its raw text). Anything else throws — a
 * parser that skipped a line it did not understand would drop a requirement without saying so.
 */
function parseToml(text: string): TomlDocument {
  const document: TomlDocument = { '': {} };
  let table = document['']!;
  const arrays = new Map<string, number>();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    const arrayHeader = /^\[\[([A-Za-z0-9_.-]+)\]\]$/.exec(line);
    if (arrayHeader !== null) {
      const count = arrays.get(arrayHeader[1]!) ?? 0;
      arrays.set(arrayHeader[1]!, count + 1);
      table = document[`${arrayHeader[1]}#${count}`] = {};
      continue;
    }
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header !== null) {
      table = document[header[1]!] ??= {};
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (pair === null) throw new Error(`unparseable TOML line ${index + 1}: ${line}`);
    const [, key, raw] = pair as unknown as [string, string, string];
    if (raw.startsWith('"""')) {
      const collected: string[] = [];
      let rest = raw.slice(3);
      while (!rest.includes('"""')) {
        collected.push(rest);
        index++;
        if (index >= lines.length) throw new Error(`unterminated """ for ${key}`);
        rest = lines[index]!;
      }
      collected.push(rest.slice(0, rest.indexOf('"""')));
      table[key] = collected.join('\n').replace(/^\n/, '');
    } else if (/^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(raw)) {
      table[key] = JSON.parse(/^"(?:[^"\\]|\\.)*"/.exec(raw)![0]) as string;
    } else if (/^(true|false)\s*(#.*)?$/.test(raw)) {
      table[key] = raw.startsWith('true');
    } else if (raw.startsWith('[') && raw.includes(']')) {
      table[key] = raw;
    } else {
      throw new Error(`unsupported TOML value on line ${index + 1}: ${line}`);
    }
  }
  return document;
}

interface Revision {
  version: string;
  file: string;
  sha256: string;
  state: string;
  predecessor: string | undefined;
  source: string;
  requirements: Set<string>;
  acceptance: TomlTable | undefined;
}

function readRevisions(): Revision[] {
  return readdirSync(REVISIONS)
    .filter((name) => name.endsWith('.toml'))
    .map((name) => {
      const toml = parseToml(readFileSync(join(REVISIONS, name), 'utf8'));
      const top = toml['']!;
      return {
        version: String(top.version),
        file: `docs/sas/revisions/${name}`,
        sha256: String(top.sha256),
        state: String(top.state),
        predecessor: top.predecessor === undefined ? undefined : String(top.predecessor),
        source: String(top.source),
        requirements: new Set(Object.keys(toml.requirements ?? {})),
        acceptance: toml.acceptance,
      };
    });
}

/** The revisions in predecessor order, first to newest; fails on a fork, an orphan or two roots. */
function chain(revisions: Revision[]): Revision[] {
  const roots = revisions.filter((revision) => revision.predecessor === undefined);
  expect(
    roots.map((root) => root.version),
    'exactly one revision may have no predecessor',
  ).toHaveLength(1);
  const ordered = [roots[0]!];
  const bySuccessor = new Map(
    revisions
      .filter((revision) => revision.predecessor !== undefined)
      .map((revision) => [revision.predecessor!, revision]),
  );
  for (let next = bySuccessor.get(ordered[0]!.version); next;) {
    ordered.push(next);
    next = bySuccessor.get(next.version);
  }
  expect(
    ordered.map((revision) => revision.version).sort(),
    'every revision must be reachable in one predecessor chain (no fork, no orphan)',
  ).toEqual(revisions.map((revision) => revision.version).sort());
  return ordered;
}

interface PendingEntry {
  subject: string;
  rule: string;
  file: string;
  recorded: string;
  review_by: string;
  pending_on: string;
  reason: string;
}

function ownerPending(): PendingEntry[] {
  const register = JSON.parse(readFileSync(OWNER_PENDING, 'utf8')) as {
    schema: string;
    entries: PendingEntry[];
  };
  expect(register.schema).toBe('kf/sas-owner-pending/v1');
  return register.entries;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Requirement ids a revision set is missing relative to its predecessor, per step. */
function removedIdentifiers(ordered: Array<{ version: string; requirements: Set<string> }>) {
  const removed: string[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const before = ordered[index - 1]!;
    const after = ordered[index]!;
    for (const id of before.requirements) {
      if (!after.requirements.has(id))
        removed.push(`${id} (${before.version} -> ${after.version})`);
    }
  }
  return removed;
}

const revisions = readRevisions();
const ordered = chain(revisions);
const newest = ordered[ordered.length - 1]!;
const sas = readFileSync(join(ROOT, SAS_PATH));

describe('the specification is governed by digest (KF-SAS-RQ-180)', () => {
  it('reads the revision records (non-vacuous)', () => {
    expect(revisions.length).toBeGreaterThanOrEqual(8);
    expect(revisions.filter((revision) => revision.state === 'accepted').length).toBeGreaterThan(0);
  });

  it('every revision names this document and a well-formed digest, in a known state', () => {
    for (const revision of revisions) {
      expect(revision.source, revision.file).toBe(SAS_PATH);
      expect(revision.sha256, revision.file).toMatch(/^[0-9a-f]{64}$/);
      expect(['proposed', 'accepted'], revision.file).toContain(revision.state);
      expect(revision.file.endsWith(`/${revision.version}.toml`), revision.file).toBe(true);
    }
  });

  it('the document on disk is exactly the one the newest revision recorded', () => {
    expect(
      sha256(sas),
      `${SAS_PATH} differs from the digest ${newest.version} (${newest.state}) recorded. An edit to ` +
        'the SAS is a new revision: `war sas propose`, never a quiet change under an old one.',
    ).toBe(newest.sha256);
  });

  it('only the newest revision may be proposed; everything before it was accepted', () => {
    const proposed = ordered.slice(0, -1).filter((revision) => revision.state !== 'accepted');
    expect(proposed.map((revision) => revision.version)).toEqual([]);
  });

  it('an accepted revision recorded the digest history fixed for it, and none was un-accepted', () => {
    const accepted = Object.fromEntries(
      revisions
        .filter((revision) => revision.state === 'accepted')
        .map((revision) => [revision.version, revision.sha256]),
    );
    expect(accepted).toEqual(ACCEPTED_DIGESTS);
  });

  it('an accepted digest was, at some commit, the actual document (when history is present)', () => {
    const shallow =
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim() === 'true';
    // A shallow clone cannot answer this, and says so rather than passing: the frozen table
    // above is still compared, so the test is not vacuous there — it is narrower.
    if (shallow) {
      expect(Object.keys(ACCEPTED_DIGESTS).length).toBeGreaterThan(0);
      return;
    }
    const commits = execFileSync('git', ['log', '--format=%H', '--', SAS_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line !== '');
    const seen = new Set(
      commits.map((commit) =>
        sha256(
          execFileSync('git', ['show', `${commit}:${SAS_PATH}`], {
            cwd: ROOT,
            maxBuffer: 64 * 1024 * 1024,
          }),
        ),
      ),
    );
    const never = Object.entries(ACCEPTED_DIGESTS)
      .filter(([, digest]) => !seen.has(digest))
      .map(([version]) => version);
    expect(never, 'an accepted revision records a document that was never committed').toEqual([]);
  });

  it('every acceptance names a human with authority to accept', () => {
    const roles = parseToml(readFileSync(ROLES, 'utf8'));
    const humans = new Set(
      Object.entries(roles)
        .filter(([name, table]) => name.startsWith('assignment#') && table.actor_kind === 'human')
        .map(([, table]) => String(table.actor)),
    );
    for (const revision of revisions.filter((candidate) => candidate.state === 'accepted')) {
      const acceptance = revision.acceptance;
      expect(acceptance, `${revision.file} is accepted with no [acceptance]`).toBeDefined();
      expect(acceptance!.actor_kind, revision.file).toBe('human');
      expect(humans.has(String(acceptance!.accepted_by)), revision.file).toBe(true);
      expect(String(acceptance!.effective_time), revision.file).toMatch(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
      );
      expect(String(acceptance!.meaning ?? '').trim(), revision.file).not.toBe('');
    }
  });

  it('every accepted revision has a signed response for its digest, or is owner-pending by name', () => {
    const pending = ownerPending();
    const unsigned: string[] = [];
    for (const revision of revisions.filter((candidate) => candidate.state === 'accepted')) {
      const path = join(RESPONSES, `SAS-${revision.version}.response.toml`);
      if (existsSync(path)) {
        const response = parseToml(readFileSync(path, 'utf8'))['']!;
        expect(response.version, path).toBe(revision.version);
        expect(response.sha256, `${path} answers a different document`).toBe(revision.sha256);
        continue;
      }
      unsigned.push(`SAS-${revision.version}`);
    }
    const listed = pending
      .filter((entry) => entry.rule === 'authority.unsigned')
      .map((entry) => entry.subject);
    // Equality: an unsigned acceptance must be listed, and a listed one that has since been
    // signed must leave the list, so the register never excuses what is already resolved.
    expect(listed.sort()).toEqual(unsigned.sort());
  });

  it('every owner-pending entry is dated, reasoned and names one file', () => {
    const entries = ownerPending();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const where = `${entry.subject} ${entry.rule}`;
      expect(entry.rule, where).toMatch(/^[a-z]+(\.[a-z-]+)+$/);
      expect(entry.rule, where).not.toContain('*');
      expect(existsSync(join(ROOT, entry.file)), `${where}: ${entry.file}`).toBe(true);
      expect(entry.recorded, where).toMatch(/^\d{4}-\d\d-\d\d$/);
      expect(entry.review_by, where).toMatch(/^\d{4}-\d\d-\d\d$/);
      expect(entry.review_by > entry.recorded, `${where}: review_by precedes recorded`).toBe(true);
      expect(entry.pending_on.trim(), where).not.toBe('');
      expect(entry.reason.trim().length, where).toBeGreaterThan(40);
    }
  });
});

describe('requirement identifiers are append-only (KF-SAS-RQ-183)', () => {
  it('each revision carries every identifier of its predecessor', () => {
    // draft.1 through draft.6 were recorded with requirement tables, so this is non-vacuous
    // from the first step.
    expect(ordered[0]!.requirements.size).toBeGreaterThan(100);
    expect(removedIdentifiers(ordered)).toEqual([]);
  });

  it('detects a removed identifier (planted)', () => {
    const planted = [
      { version: 'a', requirements: new Set(['KF-SAS-RQ-001', 'KF-SAS-RQ-002']) },
      { version: 'b', requirements: new Set(['KF-SAS-RQ-001', 'KF-SAS-RQ-003']) },
    ];
    expect(removedIdentifiers(planted)).toEqual(['KF-SAS-RQ-002 (a -> b)']);
  });

  it('the newest revision, the §106 index and the inline statements name the same set', () => {
    const text = sas.toString('utf8');
    const index = text.slice(text.indexOf('## 106. Architecture requirements index'));
    expect(index.length).toBeLessThan(text.length);
    const indexed = new Set(
      [...index.matchAll(/^\| (KF-SAS-RQ-\d+) \|/gm)].map((match) => match[1] as string),
    );
    const stated = new Set(
      [...text.matchAll(/^\*\*(KF-SAS-RQ-\d+)\.\*\*/gm)].map((match) => match[1] as string),
    );
    const sorted = (set: Set<string>) => [...set].sort();
    expect(sorted(indexed), '§106 against the newest revision').toEqual(
      sorted(newest.requirements),
    );
    expect(sorted(stated), 'inline statements against §106').toEqual(sorted(indexed));
  });

  it('§106 records no status: status is derived from evidence, never asserted there', () => {
    const text = sas.toString('utf8');
    const index = text.slice(text.indexOf('## 106. Architecture requirements index'));
    const headers = [...index.matchAll(/^\| ID \|(.*)\|$/gm)].map((match) => match[1]!.trim());
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header).toBe('Requirement');
  });
});
