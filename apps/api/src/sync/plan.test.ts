import { describe, expect, it } from 'vitest';
import { DEFAULT_BULK_CEILING, planSync, type ProjectedFile, type SyncRequest } from './plan.js';

const projected = (path: string, digest: string): ProjectedFile => ({
  path,
  digest,
  objectId: `01a0${path.length}000-0000-7000-8000-000000000000`,
  rowVersion: '3',
});

const request = (over: Partial<SyncRequest> = {}): SyncRequest => ({
  local: [],
  projected: [],
  classification: 'internal',
  ...over,
});

/**
 * Sync is a batch of proposed acts, never a merge (§48A, KF-SAS-RQ-227).
 *
 * One gesture may produce many acts. It may not produce zero — that is folder synchronisation,
 * unattributable, and what KF-SAS-RQ-021 forbids. It may not produce one act covering many items
 * — that is "I admitted this folder", the same refusal by another road.
 */
describe('planning a sync', () => {
  it('emits one act per changed file and none for unchanged ones', () => {
    const plan = planSync(
      request({
        projected: [projected('a.md', 'aaa'), projected('b.md', 'bbb')],
        local: [
          { path: 'a.md', digest: 'aaa' },
          { path: 'b.md', digest: 'CHANGED' },
          { path: 'c.md', digest: 'ccc' },
        ],
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.acts.map((act) => [act.kind, act.path])).toEqual([
      ['update', 'b.md'],
      ['add', 'c.md'],
    ]);
  });

  it('pins the row version an update was based on', () => {
    const plan = planSync(
      request({
        projected: [projected('a.md', 'aaa')],
        local: [{ path: 'a.md', digest: 'CHANGED' }],
      }),
    );
    expect(plan.ok && plan.acts[0]).toMatchObject({ kind: 'update', pinnedRowVersion: '3' });
  });

  it('proposes a withdrawal for a file deleted locally, and never a delete', () => {
    const plan = planSync(request({ projected: [projected('gone.md', 'ggg')], local: [] }));
    expect(plan.ok && plan.acts[0]?.kind).toBe('propose_withdrawal');
  });

  it('refuses without a classification rather than choosing one', () => {
    const plan = planSync({ local: [{ path: 'a.md', digest: 'a' }], projected: [] });
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.refusals.join(' ')).toMatch(/no classification given/);
  });

  it('refuses a batch above the bulk ceiling unless it is confirmed', () => {
    const many = Array.from({ length: DEFAULT_BULK_CEILING + 1 }, (_, i) => ({
      path: `f${String(i)}.md`,
      digest: 'x',
    }));
    const refused = planSync(request({ local: many }));
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.refusals.join(' ')).toMatch(/wrong directory/);

    const confirmed = planSync(request({ local: many, acceptBulk: true }));
    expect(confirmed.ok, 'an explicit confirmation is the whole escape hatch').toBe(true);
  });

  it('refuses a path that leaves the sync root', () => {
    for (const path of ['../escape.md', '/etc/passwd', 'a/../../b.md']) {
      const plan = planSync(request({ local: [{ path, digest: 'x' }] }));
      expect(plan.ok, path).toBe(false);
    }
  });

  it('refuses a local copy that lists one path twice', () => {
    const plan = planSync(
      request({
        local: [
          { path: 'a.md', digest: 'one' },
          { path: 'a.md', digest: 'two' },
        ],
      }),
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.refusals.join(' ')).toMatch(/twice/);
  });

  it('reports every problem at once, so one run says everything to fix', () => {
    const plan = planSync({
      local: [{ path: '../out.md', digest: 'x' }],
      projected: [],
    });
    expect(plan.ok).toBe(false);
    expect(
      !plan.ok && plan.refusals.length,
      'a missing classification AND an escaping path are two problems, not one',
    ).toBe(2);
  });

  it('never emits an act covering more than one file', () => {
    const plan = planSync(
      request({
        local: Array.from({ length: 12 }, (_, i) => ({ path: `f${String(i)}.md`, digest: 'x' })),
      }),
    );
    expect(plan.ok && plan.acts.length, 'twelve files, twelve acts').toBe(12);
    // There is no act shape that carries a list of paths, and that is the point: the forbidden
    // batch cannot be expressed, rather than being forbidden by a check somebody could forget.
    expect(plan.ok && plan.acts.every((act) => typeof act.path === 'string')).toBe(true);
  });
});
