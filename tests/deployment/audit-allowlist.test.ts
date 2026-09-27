/**
 * Dependency advisories fail the gate at `moderate`, and every exception is a dated review.
 *
 * The gate ran `pnpm audit --audit-level=high` until 2026-09-23, so a moderate advisory never
 * reached a person at all. Lowering the level surfaced two (a vitest path traversal); the fix
 * was not to keep `high`, but to make each accepted advisory an explicit entry in
 * `auditConfig.ignoreGhsas` whose review can go stale. This file is what makes it go stale.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...path: string[]): string => readFileSync(join(ROOT, ...path), 'utf8');

describe('dependency advisories', () => {
  it('fail the gate and CI at moderate, not high', () => {
    const gate = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts[
      'gate'
    ]!;
    const ci = read('.github', 'workflows', 'ci.yml');
    for (const [where, text] of [
      ['package.json gate', gate],
      ['ci.yml', ci],
    ] as const) {
      const levels = [...text.matchAll(/pnpm audit --audit-level=(\w+)/g)].map((m) => m[1]);
      expect(levels.length, `${where} runs no pnpm audit`).toBeGreaterThan(0);
      expect(
        levels.every((level) => level === 'moderate' || level === 'low'),
        where,
      ).toBe(true);
    }
  });

  it('accepts an advisory only with a named review and a revisit date still in the future', () => {
    const workspace = read('pnpm-workspace.yaml');
    const block = /^auditConfig:\n {2}ignoreGhsas:\n((?: {4}- .+\n?)*)/m.exec(workspace);
    const ignored =
      block === null ? [] : [...block[1]!.matchAll(/- (GHSA-[\w-]+)/g)].map((m) => m[1]!);
    const today = new Date().toISOString().slice(0, 10);
    for (const ghsa of ignored) {
      // The review is the comment paragraph that names the advisory.
      const start = workspace.indexOf(`# ${ghsa}`);
      expect(start, `${ghsa} is ignored with no review comment naming it`).toBeGreaterThanOrEqual(
        0,
      );
      const review = workspace.slice(start, workspace.indexOf('\n\n', start) >>> 0);
      expect(review, `${ghsa} review has no reviewed: date`).toMatch(/reviewed: \d{4}-\d{2}-\d{2}/);
      expect(review, `${ghsa} review gives no reason`).toMatch(/why: \S/);
      const revisit = /revisit-by: (\d{4}-\d{2}-\d{2})/.exec(review)?.[1];
      expect(revisit, `${ghsa} review has no revisit-by date`).toBeDefined();
      expect(
        revisit! >= today,
        `${ghsa} was due for re-review on ${revisit}: upgrade, or review it again and move the date`,
      ).toBe(true);
    }
  });
});
