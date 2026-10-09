/**
 * `kf-commissioning --json > file` is how a host records its commissioning evidence
 * (docs/deployment/private-host.md, "Commissioning: run it, do not read it"). The report was
 * written to stderr, so that redirect produced an empty file on the first rehearsal of the VPS
 * install (KF-WAR-0001, 2026-10-07) while the JSON went to the terminal.
 *
 * WHAT THIS CANNOT DO. It reads the CLI's source rather than running it: the CLI runs every
 * check against the machine it is on (systemctl, ss, the filesystem) at import, which a unit
 * test must not do. It holds the one property that broke — the report is written with
 * process.stdout.write — and nothing about the report's content, which
 * packages/operations/src/commissioning.test.ts covers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = join(
  import.meta.dirname,
  '..',
  '..',
  'packages',
  'operations',
  'src',
  'commissioning-cli.ts',
);

describe('kf-commissioning writes its report to stdout', () => {
  it('both the JSON evidence record and the readable report', () => {
    const source = readFileSync(CLI, 'utf8');
    expect(source).toContain('process.stdout.write(`${JSON.stringify(report, null, 2)}\\n`);');
    expect(source).toContain('process.stdout.write(`${formatCommissioning(report)}\\n`);');
    expect(source).not.toMatch(
      /console\.(warn|error)\((JSON\.stringify\(report|formatCommissioning)/,
    );
  });
});
