/**
 * A gate's qualification is a claim about a specific battery, at a specific state of that
 * battery. If the battery moves, the claim is about something that no longer exists.
 *
 * `docs/gates/kf.host.commissioning@1.0.0.yaml` records the digest of
 * `packages/operations/src/commissioning.test.ts` as it stood when the gate was qualified. That
 * digest sits in a prose `qualification_limitations` line, where nothing recomputes it — which a
 * review of the qualifying commit named as the hole this file closes: someone edits the battery,
 * commits, and no tool says the gate's basis changed.
 *
 * The rule is NOT "the battery may never change". It is "changing it re-opens qualification".
 * When this fails, the fix is to re-run the battery, confirm every declared fault class is still
 * detected, and update the digest — not to update the digest.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const GATES = join(ROOT, 'docs', 'gates');

/** Every gate definition in the registry, by filename. */
function gateFiles(): readonly string[] {
  return readdirSync(GATES).filter((name) => name.endsWith('.yaml'));
}

describe('a qualified gate still describes the battery that qualified it', () => {
  it('finds gate definitions at all, so the rest of this file is not vacuous', () => {
    expect(
      gateFiles().length,
      'no gate definitions found under docs/gates; this file would check nothing',
    ).toBeGreaterThan(0);
  });

  it('recomputes every qualifier digest a gate records', () => {
    const stale: string[] = [];
    let checked = 0;

    for (const file of gateFiles()) {
      const text = readFileSync(join(GATES, file), 'utf8');
      // A recorded digest looks like `sha256:<64 hex>` and is followed, in the same document, by
      // the path of the artifact it digests. Both are read from the file rather than hardcoded
      // here, so adding a second gate needs no change to this test.
      const digest = /sha256:([0-9a-f]{64})/.exec(text)?.[1];
      const qualifier = /qualification_qualifier:\s*"([^",]+)/.exec(text)?.[1]?.trim();
      if (digest === undefined || qualifier === undefined) continue;

      checked += 1;
      const actual = createHash('sha256')
        .update(readFileSync(join(ROOT, qualifier)))
        .digest('hex');
      if (actual !== digest) {
        stale.push(
          `${file}: records ${digest.slice(0, 12)} for ${qualifier}, which is now ${actual.slice(0, 12)}`,
        );
      }
    }

    expect(
      checked,
      'no gate recorded both a qualifier path and a digest, so nothing was compared',
    ).toBeGreaterThan(0);
    expect(
      stale,
      'a gate qualification names a battery that has changed since it qualified the gate. ' +
        'Re-run the battery and confirm every declared fault class is still detected, THEN ' +
        'update the digest. Updating the digest alone re-states a claim nobody re-checked.',
    ).toEqual([]);
  });
});
