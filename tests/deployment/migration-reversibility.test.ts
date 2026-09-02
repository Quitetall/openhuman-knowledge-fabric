/**
 * The rollback rehearsal claims migrations are reversible. Seven of them are not.
 *
 * `migrate-release.sh rehearse` used to migrate up, migrate all the way down, and assert the
 * database came back empty. That assertion cannot hold here: seven migrations are deliberate
 * one-way security hardening, and their down sections are empty on purpose —
 * `20260816000300_typed_table_row_security` reverts to 29 tables readable by any role that can
 * connect. So the rehearsal was asserting something the schema had already made false.
 *
 * The fix is not to weaken the assertion to "at most". It is to make the promise narrower and
 * still exact: a migration may DECLARE itself irreversible with `-- kf:forward-only <reason>`,
 * rollback runs down to the highest such migration, and the rehearsal asserts it stopped there
 * — by version, not by count.
 *
 * WHAT THIS FILE GUARDS is the fail-closed half, because that is the half that decays. An
 * empty down section with no declaration is indistinguishable at run time from a deliberate
 * one, and the difference only surfaces when a rollback needs it and does nothing. Every
 * assertion below plants that exact defect and requires the verifier to NAME it — the tests
 * were confirmed to fail with each guard removed before being committed.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const VERIFIER = join(ROOT, 'scripts', 'deploy', 'migrate-release.sh');
const MIGRATIONS = join(ROOT, 'database', 'migrations');
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * A release tree carrying exactly the given migrations. Everything else is the minimum the
 * verifier needs to reach the migration classifier — it runs several preconditions first, and
 * a fixture that trips one of those would pass this file for the wrong reason.
 */
function releaseWith(migrations: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kf-migrations-'));
  made.push(root);
  mkdirSync(join(root, 'database', 'migrations'), { recursive: true });
  for (const [name, body] of Object.entries(migrations)) {
    writeFileSync(join(root, 'database', 'migrations', name), body);
  }
  mkdirSync(join(root, 'generated', 'sql-registry'), { recursive: true });
  writeFileSync(join(root, 'generated', 'sql-registry', '001-ontology-seed.sql'), 'select 1;\n');
  execFileSync(
    'bash',
    [
      '-c',
      [
        'set -e',
        'cd "$1"',
        "find -P . -mindepth 1 -type d -printf '%P\\n' | LC_ALL=C sort > DIRECTORIES",
        "find -P . -type l -printf '%P\\t%l\\n' | LC_ALL=C sort > SYMLINKS",
        "find -P . -type f ! -path ./SHA256SUMS -printf '%P\\0' | LC_ALL=C sort -z" +
          ' | xargs -0 sha256sum > SHA256SUMS',
      ].join('\n'),
      'bash',
      root,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chmodSync(root, 0o755);
  return root;
}

/** Runs `migrate-release.sh check` and returns everything it said, however it exited. */
function check(root: string): { status: number; output: string } {
  try {
    const output = execFileSync('bash', [VERIFIER, 'check', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KF_EXPECTED_RELEASE_OWNER_UID: String(process.getuid?.() ?? 0),
        KF_EXPECTED_RELEASE_MANIFEST_SHA256: createHash('sha256')
          .update(readFileSync(join(root, 'SHA256SUMS')))
          .digest('hex'),
      },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

const REVERSIBLE = '-- migrate:up\ncreate table t1 ();\n-- migrate:down\ndrop table t1;\n';

describe('an undeclared irreversible migration is refused, not silently tolerated', () => {
  it('names the migration whose down section is empty and undeclared', () => {
    const { status, output } = check(
      releaseWith({
        '20260101000000_reversible.sql': REVERSIBLE,
        // Somebody wrote `-- migrate:down` and stopped. Indistinguishable from the deliberate
        // case until a rollback needs it, which is why it cannot be allowed to pass.
        '20260101000100_forgotten.sql': '-- migrate:up\ncreate table t2 ();\n-- migrate:down\n',
      }),
    );
    expect(status, 'the verifier accepted a migration that silently reverts nothing').not.toBe(0);
    expect(output).toContain('20260101000100_forgotten.sql');
    expect(output).toContain('kf:forward-only');
  });

  it('rejects a declaration with no reason, which is the whole cost of the escape hatch', () => {
    const { status, output } = check(
      releaseWith({
        '20260101000000_reversible.sql': REVERSIBLE,
        '20260101000100_unreasoned.sql':
          '-- migrate:up\ncreate table t2 ();\n-- migrate:down\n-- kf:forward-only \n',
      }),
    );
    expect(
      status,
      'a bare `-- kf:forward-only` with no reason was accepted as a declaration. The reason is ' +
        'the only artifact a reviewer reads to judge whether the irreversibility was intended.',
    ).not.toBe(0);
    expect(output).toContain('20260101000100_unreasoned.sql');
  });

  it('rejects declaring forward-only while still carrying down statements', () => {
    // One of the two is a lie and there is no safe way to guess which, so neither is assumed.
    const { status, output } = check(
      releaseWith({
        '20260101000000_contradictory.sql':
          '-- migrate:up\ncreate table t1 ();\n' +
          '-- migrate:down\n-- kf:forward-only cannot be undone\ndrop table t1;\n',
      }),
    );
    expect(status).not.toBe(0);
    expect(output).toContain('20260101000000_contradictory.sql');
  });

  it('accepts a properly declared forward-only migration', () => {
    // Cannot assert exit 0: `check` goes on to require a packaged dbmate the fixture has no
    // reason to carry. What it CAN assert is that the classifier did not object — otherwise
    // the three refusals above would also pass against a verifier that refuses everything.
    const { output } = check(
      releaseWith({
        '20260101000000_reversible.sql': REVERSIBLE,
        '20260101000100_declared.sql':
          '-- migrate:up\ncreate table t2 ();\n' +
          '-- migrate:down\n-- kf:forward-only reverting would restore unrestricted reads\n',
      }),
    );
    expect(output).not.toContain('kf:forward-only');
    expect(output).not.toContain('20260101000100_declared.sql');
  });
});

/** Migrations that declare themselves irreversible, in the order dbmate applies them. */
function declaredForwardOnly(): string[] {
  return execFileSync('bash', ['-c', `ls "${MIGRATIONS}"/*.sql`], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((path) => /^-- kf:forward-only \S/m.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(path.lastIndexOf('/') + 1));
}

describe('the runbook describes the floor that actually exists', () => {
  // Four separate defects on this repo have been a hand-written count in prose that nothing
  // compared to the thing it counted. Both numbers below are load-bearing: an operator reads
  // them to decide whether a rehearsal that stopped short is correct or is a failure.
  const WORDS: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    'twenty-one': 21,
    'twenty-two': 22,
    'twenty-three': 23,
    'twenty-four': 24,
    'twenty-five': 25,
  };

  it('states the right number of forward-only migrations', () => {
    const document = readFileSync(join(ROOT, 'docs', 'deployment', 'private-host.md'), 'utf8');
    const word = /\*\*The floor[^]*?([\w-]+) migrations are one-way/.exec(document)?.[1];
    expect(
      word,
      'the forward-only paragraph moved or was reworded; this guard is now blind',
    ).toBeDefined();
    const stated = WORDS[(word ?? '').toLowerCase()];
    expect(stated, `private-host.md says "${word}", which is not a number I can check`).toBeTypeOf(
      'number',
    );
    expect(stated, 'private-host.md states a forward-only count the migrations disagree with').toBe(
      declaredForwardOnly().length,
    );
  });

  it('names the migration that is actually the floor', () => {
    const document = readFileSync(join(ROOT, 'docs', 'deployment', 'private-host.md'), 'utf8');
    // The floor is the HIGHEST declaration, not the first or the most memorable. Rollback stops
    // there, so naming the wrong one tells an operator to expect the wrong end state.
    const highest = declaredForwardOnly().at(-1);
    expect(
      highest,
      'nothing declares itself forward-only, so there is no floor to name',
    ).toBeDefined();
    const floor = (highest ?? '').replace(/\.sql$/, '');
    // Anchored to the sentence that makes the CLAIM, not to the document. A bare
    // `document.includes(floor)` passed even with the prose naming a different migration,
    // because the measured-rehearsal table below it also contains the correct name — the guard
    // was satisfied by a different sentence than the one it was written to check.
    // `\s+` between words, not a literal space: prettier rewraps this paragraph, and the
    // sentence is currently split across a line break mid-phrase. A guard that only matches
    // one wrapping goes blind the next time the paragraph grows by a word.
    const claim =
      /rollback\s+stops\s+at\s+the\s+highest\s+such\s+migration\s+\(currently\s+`([^`]+)`\)/;
    const named = claim.exec(document)?.[1];
    expect(
      named,
      'the sentence naming the forward-only floor moved or was reworded; this guard is now blind',
    ).toBeDefined();
    expect(
      named,
      `private-host.md tells the operator rollback stops at ${named}, but the highest migration ` +
        `declaring itself forward-only is ${floor}`,
    ).toBe(floor);
  });
});

describe('the shipped migration set states its own irreversibility', () => {
  it('every empty down section carries a reason', () => {
    const names = execFileSync('bash', ['-c', `ls "${MIGRATIONS}"/*.sql`], { encoding: 'utf8' })
      .trim()
      .split('\n');
    const undeclared: string[] = [];
    for (const path of names) {
      const body = readFileSync(path, 'utf8');
      const down = body.slice(body.indexOf('-- migrate:down'));
      const statements = down.split('\n').filter((line) => /^\s*[^-\s]/.test(line));
      const declared = /^-- kf:forward-only \S/m.test(down);
      if (statements.length === 0 && !declared) undeclared.push(path);
    }
    expect(
      undeclared,
      'these migrations revert nothing and do not say why. A rollback rehearsal that includes ' +
        'them reports success while leaving the schema in place.',
    ).toEqual([]);
  });
});
