/**
 * The test harness and the deployed server must agree on how PostgreSQL plans queries.
 *
 * They did not. `docker-compose.yml` passed `log_statement=ddl` and the harness did not, and
 * nothing noticed — which is fine for a logging knob and would not have been fine for a planner
 * one. A measurement taken against a server configured differently from the one people run
 * describes nothing, and this repository takes measurements against the harness on purpose
 * (`tests/database/rls-read-cost.test.ts`).
 *
 * So: every `-c name=value` compose passes must also be passed by the harness, unless the
 * setting is on the deployment-only list below with a stated reason. Divergence is a failure,
 * not a warning.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Settings the harness deliberately does not copy.
 *
 * Only for knobs that cannot change a query plan or a result. Anything that can belongs in both.
 */
const DEPLOYMENT_ONLY = new Map<string, string>([
  [
    'log_statement',
    'server-side DDL logging for the dev stack; affects what is written to the log, never what ' +
      'a query returns or how it is planned',
  ],
]);

/** `-c name=value` pairs from the postgres service's command list. */
function composeSettings(): Map<string, string> {
  return parseComposeSettings(readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8'));
}

/**
 * Exported shape so a synthetic document can be fed in, which is the only way to prove the
 * scoping below actually scopes.
 *
 * Narrowed to the `command:` list on purpose. Matching `- name=value` anywhere in the service
 * block would also swallow `environment:` written in list form — `- POSTGRES_DB=kf` — and this
 * file would then demand the harness set POSTGRES_DB as though it were a server setting. The
 * compose file happens to use mapping form today, so the looser version was correct by luck
 * rather than by construction.
 */
export function parseComposeSettings(yaml: string): Map<string, string> {
  const at = yaml.indexOf('\n  postgres:');
  if (at < 0) throw new Error('no postgres service in docker-compose.yml');
  const service = yaml.slice(at + 1);
  const serviceEnd = service.search(/\n {2}[a-z0-9_-]+:/);
  const block = serviceEnd < 0 ? service : service.slice(0, serviceEnd);

  const commandAt = block.indexOf('\n    command:');
  if (commandAt < 0) throw new Error('the postgres service no longer has a command: list');
  const afterCommand = block.slice(commandAt + 1);
  // Ends at the next service PROPERTY (four-space indent), not the next list item.
  const commandEnd = afterCommand.slice(1).search(/\n {4}[a-z0-9_-]+:/);
  const commandBlock = commandEnd < 0 ? afterCommand : afterCommand.slice(0, commandEnd + 1);

  const found = new Map<string, string>();
  for (const [, name, value] of commandBlock.matchAll(/^\s*-\s*([a-z_]+)=(\S+)/gm)) {
    found.set(name!, value!);
  }
  return found;
}

/** The same pairs from the harness's `withCommand([...])`. */
function harnessSettings(): Map<string, string> {
  const source = readFileSync(join(process.cwd(), 'tests/database/harness.ts'), 'utf8');
  const at = source.indexOf('.withCommand(');
  if (at < 0) throw new Error('harness no longer calls withCommand');
  const block = source.slice(at, source.indexOf('])', at));
  const found = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/'([a-z_]+)=(\S+?)'/g)) {
    found.set(name!, value!);
  }
  return found;
}

describe('postgres settings parity between the harness and the deployed server', () => {
  it('reads real settings out of both, so a broken parser cannot pass this file', () => {
    // Both extractors are regex over someone else's file format. If either quietly returned
    // nothing, every comparison below would hold vacuously and this file would be decoration.
    const compose = composeSettings();
    const harness = harnessSettings();
    // Emptiness is the parser failure. A COUNT is not: asserting "more than two" here made
    // this case fire when the harness legitimately dropped to two settings, reporting a broken
    // parser when the parser was fine and the real complaint belonged to the test below it.
    expect(compose.size, 'parsed no settings out of docker-compose.yml').toBeGreaterThan(0);
    expect(harness.size, 'parsed no settings out of harness.ts').toBeGreaterThan(0);
    expect(compose.get('wal_level'), 'compose parser is not reading values').toBe('logical');
    expect(harness.get('wal_level'), 'harness parser is not reading values').toBe('logical');
  });

  it('reads only the command list, not environment entries that look like settings', () => {
    // The scoping is the point, so it is tested against a document written to break the looser
    // version rather than against the real file, which uses mapping-form environment and would
    // pass either way. Review raised this; it was correct by luck before.
    // The environment entries must be LOWERCASE and NOT also set by the command, or this proves
    // nothing — which is how the first version passed against the very parser it was written to
    // reject. `POSTGRES_DB` never matched the `[a-z_]+` name pattern, and an environment `jit`
    // was silently overwritten by the command's `jit`, so both assertions held either way.
    // `work_mem` matches the pattern and appears nowhere else. Confirmed by running the loose
    // parser against this document: it reports ['jit', 'work_mem'] and fails.
    const synthetic = [
      'services:',
      '  postgres:',
      '    environment:',
      '      - work_mem=64MB',
      '      - POSTGRES_DB=kf',
      '    command:',
      '      - postgres',
      '      - -c',
      '      - jit=off',
      '    ports:',
      "      - '127.0.0.1:5432:5432'",
      '  minio:',
      '    command:',
      '      - shared_buffers=wrong',
      '',
    ].join('\n');
    const parsed = parseComposeSettings(synthetic);
    expect(parsed.get('jit'), 'took the environment value instead of the command one').toBe('off');
    expect([...parsed.keys()], 'leaked environment or another service into the settings').toEqual([
      'jit',
    ]);
  });

  it('gives the harness every planner-affecting setting the deployed server has', () => {
    const compose = composeSettings();
    const harness = harnessSettings();
    const missing = [...compose.keys()].filter(
      (name) => !DEPLOYMENT_ONLY.has(name) && !harness.has(name),
    );
    expect(
      missing,
      `docker-compose.yml sets these and the harness does not, so tests measure a server ` +
        `nobody runs: ${missing.join(', ')}. Add them to tests/database/harness.ts, or add them ` +
        `to DEPLOYMENT_ONLY with a reason they cannot affect a plan or a result.`,
    ).toEqual([]);
  });

  it('agrees on the value wherever both set the same thing', () => {
    const compose = composeSettings();
    const harness = harnessSettings();
    const disagreements = [...compose.entries()]
      .filter(([name, value]) => harness.has(name) && harness.get(name) !== value)
      .map(([name, value]) => `${name}: compose=${value} harness=${harness.get(name)}`);
    expect(disagreements, 'same setting, different value').toEqual([]);
  });

  it('keeps jit off in all three places, which is the setting this file was written for', () => {
    // Named explicitly rather than left to the generic check above, which compares compose
    // against the harness and would therefore still pass if someone deleted the setting from
    // BOTH of them. JIT being on cost a measured 8-14x on RLS-filtered scans.
    expect(composeSettings().get('jit'), 'docker-compose.yml no longer disables jit').toBe('off');
    expect(harnessSettings().get('jit'), 'the harness no longer disables jit').toBe('off');

    // The third surface, and the one that actually serves users. compose is the dev stack and
    // the harness is tests; a private host gets its settings by including this file from
    // postgresql.conf. Fixing the first two and not this one would leave production as the only
    // place still running the slow configuration.
    const planner = readFileSync(join(process.cwd(), 'deploy/postgres/planner.conf'), 'utf8');
    const setting = planner
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .find((line) => line.includes('jit'));
    expect(setting, 'deploy/postgres/planner.conf no longer sets jit').toBeDefined();
    expect(setting!.replace(/\s+/g, '')).toBe('jit=off');
  });
});
