/**
 * The threat model's open items still describe what is actually true.
 *
 * The path-resolution half of this file moved to `docs-references.test.ts`, which checks every
 * repo-relative citation across the whole documentation tree rather than this one document —
 * the same guard, generalised, and one fewer near-duplicate to keep in step.
 *
 * What is left is the part that is specific to this document and cannot be generalised: its
 * open-items table is the only place in the repository that says which risks are accepted and
 * which are merely unbuilt, and the difference between those two is not visible in code.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const THREAT_MODEL = join(ROOT, 'docs', 'threat-model', 'README.md');

describe('the threat model records what is accepted and what is merely unbuilt', () => {
  it('describes open item 5 as the half that code cannot close', () => {
    // This assertion previously required that NO alert unit shipped, because the threat model
    // called item 5 "a genuine gap" and an undelivered `OnFailure=` was the gap. The unit now
    // ships — and the test failing on the commit that added it is exactly what forced the
    // document to be rewritten in the same commit rather than a later one.
    //
    // What it holds now is the residue: the unit exists and is tested, so the document must no
    // longer call it missing, and must still say that nobody has received one. A delivery path
    // that passes every check and reaches an abandoned channel is the failure this cannot
    // detect, and the document is the only place that can say so.
    const body = readFileSync(THREAT_MODEL, 'utf8');
    expect(
      existsSync(join(ROOT, 'deploy', 'systemd', 'kf-alert@.service')),
      'the alert unit is gone; the threat model still describes it as shipped',
    ).toBe(true);
    expect(
      existsSync(join(ROOT, 'deploy', 'systemd', 'kf-alert-heartbeat.timer')),
      'the heartbeat timer is gone, so a dead alert path is undetectable again',
    ).toBe(true);
    expect(
      body,
      'the threat model must still record that no person has received an alert; that is host ' +
        'evidence and shipping the unit did not supply it',
    ).toContain('nobody has yet received one');
    expect(
      body,
      'the threat model no longer states that the alert carries no log content, which is the ' +
        'data-boundary rule the payload assertion enforces',
    ).toContain('carries no log content');
  });
});
