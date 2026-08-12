/**
 * The shell scripts' half of the secrets rule.
 *
 * `psql "postgres://user:pass@host/db"` puts the password in the process's command line, and
 * `/proc/<pid>/cmdline` is readable by EVERY account on the host — a weaker position than the
 * environment, which at least requires the same user. The rest of this system refuses inline
 * credentials for that reason, so the scripts reintroducing one on argv would be the sort of
 * inconsistency that survives for years because nobody looks at the shell.
 *
 * These tests run the real `scripts/lib/secret.sh`, because a TypeScript reimplementation of
 * what it does would pass while the shell was broken.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'kf-script-creds-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const keywordFile = join(work, 'conninfo');

const LIB = join(import.meta.dirname, '..', '..', 'scripts', 'lib', 'secret.sh');

/**
 * Run a snippet with the library sourced.
 *
 * Both streams, always. Every refusal in `secret.sh` writes to stderr, so a helper that kept
 * only stdout would report an empty string for exactly the cases these tests exist to check.
 *
 * `env` is applied to the process, which means it is in place BEFORE the library is sourced —
 * necessary for anything that changes what `kf_pgpass_init` decides at source time.
 */
function sh(snippet: string, env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n. "${LIB}"\n${snippet}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('moving the password out of the connection string', () => {
  it('strips it from the URL and puts it in a 0600 PGPASSFILE', () => {
    const r = sh(`
      url="$(kf_pgpass_url "postgres://kf_app:hunter2@db.internal:5432/kf")"
      printf 'URL=%s\\n' "$url"
      printf 'MODE=%s\\n' "$(stat -c %a "$PGPASSFILE")"
      printf 'ENTRY=%s\\n' "$(cat "$PGPASSFILE")"
    `);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('URL=postgres://kf_app@db.internal:5432/kf');
    // The line that matters: what psql receives on argv carries no credential.
    expect(r.out.split('\n').find((l) => l.startsWith('URL='))).not.toContain('hunter2');
    expect(r.out).toContain('MODE=600');
    expect(r.out).toContain('ENTRY=db.internal:5432:*:kf_app:hunter2');
  });

  it('uses a wildcard database, because these scripts do not stay in one', () => {
    // pg_dumpall reads the cluster's roles from `postgres`; the drill creates and drops a
    // scratch database; the restore targets a third. An entry pinned to the URL's database
    // matches none of those, and the symptom is `fe_sendauth: no password supplied` from
    // whichever tool moved first — which reads like a permissions problem and is not one.
    const r = sh(`kf_pgpass_url "postgres://u:p@h:5432/onedb" >/dev/null; cat "$PGPASSFILE"`);
    expect(r.out.trim()).toBe('h:5432:*:u:p');
  });

  it('escapes the characters pgpass treats specially', () => {
    const r = sh(`kf_pgpass_url 'postgres://u:a:b\\c@h/d' >/dev/null; cat "$PGPASSFILE"`);
    // A colon in a password would otherwise end the field and shift every one after it.
    expect(r.out.trim()).toBe('h:*:*:u:a\\:b\\\\c');
  });

  it('leaves a URL with no password alone', () => {
    const r = sh(`kf_pgpass_url "postgres://kf_app@db/kf"`);
    expect(r.out.trim()).toBe('postgres://kf_app@db/kf');
  });

  it('removes the password file however the script exits', () => {
    const r = sh(`
      kf_pgpass_url "postgres://u:p@h/d" >/dev/null
      printf '%s\\n' "$PGPASSFILE"
    `);
    const path = r.out.trim().split('\n').pop() ?? '';
    expect(path).not.toBe('');
    expect(existsSync(path), `${path} survived the script`).toBe(false);
  });

  it('still removes it when the script installs its own exit handler', () => {
    // `trap ... EXIT` REPLACES what was there. A script that set its own trap after sourcing
    // would silently discard the one that removes the password file — which is why hooks
    // accumulate through kf_at_exit rather than each caller installing its own.
    const r = sh(`
      kf_pgpass_url "postgres://u:p@h/d" >/dev/null
      mine() { echo "MINE RAN"; }
      kf_at_exit mine
      printf '%s\\n' "$PGPASSFILE"
    `);
    const lines = r.out.trim().split('\n');
    const path = lines.find((l) => l.startsWith('/')) ?? '';
    expect(r.out).toContain('MINE RAN');
    expect(existsSync(path), `${path} survived the script`).toBe(false);
  });
});

describe('refusing what it cannot do safely', () => {
  it('refuses a keyword/value string with an inline password', () => {
    // Handled by refusing rather than by a second parser: the password would still reach
    // argv, and a helper that silently did nothing here would be the worst of the options.
    const r = sh(`kf_pgpass_url "host=db user=kf password=hunter2"`);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/every account on this host can read it/);
    expect(r.out).not.toContain('hunter2');
  });

  it('refuses percent-encoding rather than guessing at it', () => {
    // libpq decodes %XX in the userinfo. Reimplementing that here and getting it subtly wrong
    // produces a pgpass entry that simply fails to authenticate, and "wrong password" is a
    // miserable thing to debug at the far end of a restore.
    const r = sh(`kf_pgpass_url "postgres://kf:pa%%73s@h/d"`);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/percent-encoding/);
  });

  it('will not edit a PGPASSFILE the operator set themselves', () => {
    // Set in the ENVIRONMENT, so it is there before the library is sourced. Exporting it
    // inside the snippet would be too late: kf_pgpass_init runs at source time, and would
    // already have created and claimed a file of its own.
    const theirs = join(tmpdir(), `kf-not-ours-${process.pid}`);
    const r = sh(`kf_pgpass_url "postgres://u:p@h/d"`, { PGPASSFILE: theirs });
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/does not own/);
    // Refused, not appended to. Editing a file this script did not create is the thing being
    // avoided, so the file must not have been created either.
    expect(existsSync(theirs)).toBe(false);
  });
});

describe('no script may install a bare EXIT trap', () => {
  it('is enforced by reading the scripts, because this bug has happened twice', () => {
    // `trap ... EXIT` REPLACES the handler rather than adding to it, so a script that sets
    // its own after sourcing secret.sh silently discards the one that removes the temporary
    // password file — leaving a 0600 file containing a production credential in /tmp.
    //
    // It was written that way in restore-drill.sh, fixed, and then found again in
    // restore-verify.sh. A rule that has to be remembered twice is one to check instead.
    const dir = join(import.meta.dirname, '..', '..', 'scripts');
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sh'))) {
      const body = readFileSync(join(dir, name), 'utf8');
      for (const [i, line] of body.split('\n').entries()) {
        // A `trap` naming EXIT anywhere in the line, not only at its start: `cmd && trap ...
        // EXIT` installs exactly the same replacing handler. kf_at_exit's own installation is
        // the one legitimate use and lives in lib/, which this loop does not read.
        if (/(^|[;&|]|\bthen\b|\bdo\b)\s*trap\s+.*\bEXIT\b/.test(line)) {
          offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      'use kf_at_exit instead — a bare trap replaces the cleanup that removes the password file',
    ).toEqual([]);
  });
});

describe('reading the connection string from a file', () => {
  it('refuses one readable beyond its owner', () => {
    const r = sh(
      `
      printf 'postgres://u:p@h/d\\n' > "$DATABASE_URL_FILE"
      chmod 644 "$DATABASE_URL_FILE"
      kf_resolve_database_url || true
    `,
      { DATABASE_URL_FILE: join(work, 'loose') },
    );
    // Matches loadSecret() in packages/operations, so the two halves of the deployment agree
    // about what an acceptable secret file looks like.
    expect(r.out).toMatch(/readable beyond its owner/);
  });

  it('keeps internal spaces, which a libpq keyword string needs', () => {
    const r = sh(
      `
      printf 'host=db user=kf dbname=kf\\n' > "$DATABASE_URL_FILE"
      chmod 600 "$DATABASE_URL_FILE"
      kf_resolve_database_url
      printf '[%s]\\n' "$DATABASE_URL"
    `,
      { DATABASE_URL_FILE: keywordFile },
    );
    expect(r.out).toContain('[host=db user=kf dbname=kf]');
  });
});
