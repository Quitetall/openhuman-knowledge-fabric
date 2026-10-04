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

function batteries(text: string): readonly { path: string; digest: string }[] {
  // Supplementary references can precede the legacy primary note in the YAML.
  const primary = text.replace(
    /Supplementary battery: [A-Za-z0-9_./-]+; sha256:[0-9a-f]{64};/g,
    '',
  );
  const digest = /sha256:([0-9a-f]{64})/.exec(primary)?.[1];
  const qualifier = /qualification_qualifier:\s*"([^",]+)/.exec(text)?.[1]?.trim();
  const result = digest && qualifier ? [{ path: qualifier, digest }] : [];
  const supplementary = [
    ...text.matchAll(/Supplementary battery: ([A-Za-z0-9_./-]+); sha256:([0-9a-f]{64});/g),
  ];
  if (supplementary.length !== (text.match(/Supplementary battery:/g) ?? []).length)
    throw new Error('malformed supplementary qualification reference');
  for (const match of supplementary) result.push({ path: match[1]!, digest: match[2]! });
  for (const entry of result) {
    if (entry.path.startsWith('/') || entry.path.split('/').includes('..'))
      throw new Error('qualifier outside repository');
  }
  return result;
}
function staleBatteries(text: string, contents: (path: string) => Buffer): string[] {
  return batteries(text).flatMap((entry) => {
    const actual = createHash('sha256').update(contents(entry.path)).digest('hex');
    return actual === entry.digest
      ? []
      : [`${entry.path}: records ${entry.digest.slice(0, 12)}, now ${actual.slice(0, 12)}`];
  });
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
      checked += batteries(text).length;
      stale.push(
        ...staleBatteries(text, (path) => readFileSync(join(ROOT, path))).map(
          (message) => `${file}: ${message}`,
        ),
      );
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
  it('detects a changed supplementary battery even when the primary remains unchanged', () => {
    const bytes = Buffer.from('public fixture');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const text = `qualification_qualifier: "primary.ts, fixture"\nsha256:${digest}\nSupplementary battery: supplementary.ts; sha256:${digest}; fixture`;
    expect(staleBatteries(text, () => bytes)).toEqual([]);
    expect(
      staleBatteries(
        `Supplementary battery: supplementary.ts; sha256:${digest};\n` +
          `qualification_qualifier: "primary.ts, fixture"\nsha256:${digest}`,
        () => bytes,
      ),
    ).toEqual([]);
    expect(
      staleBatteries(text, (path) =>
        path === 'supplementary.ts' ? Buffer.from('changed') : bytes,
      ),
    ).toHaveLength(1);
    expect(() => batteries('Supplementary battery: missing digest')).toThrow();
    expect(() => batteries(`Supplementary battery: ../outside; sha256:${digest};`)).toThrow();
  });
});
