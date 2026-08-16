import { describe, expect, it } from 'vitest';
import { TASKS, taskList } from './tasks.js';

describe('task registry', () => {
  it('exposes every registered task by name', () => {
    const list = taskList();
    expect(Object.keys(list).sort()).toEqual(TASKS.map((t) => t.name).sort());
  });

  it('namespaces task names so they cannot collide with another producer', () => {
    for (const task of TASKS) expect(task.name).toMatch(/^kf\./);
  });

  it('requires a description for every task', () => {
    for (const task of TASKS) expect(task.description.length).toBeGreaterThan(0);
  });

  it('runs the echo task without side effects', async () => {
    const list = taskList();
    await expect(list['kf.echo']?.({ any: 'payload' })).resolves.toBeUndefined();
  });

  it('dispatches a typed compiler job only through the configured runtime', async () => {
    const seen: string[] = [];
    const list = taskList({
      compileDocument: async (actionId) => {
        seen.push(actionId);
      },
    });
    await list['kf.compile_document']?.({
      actionId: '01940000-0000-8000-8000-000000000001',
    });
    expect(seen).toEqual(['01940000-0000-8000-8000-000000000001']);

    await expect(list['kf.compile_document']?.({ action_id: 'wrong-field' })).rejects.toThrow(
      /actionId/,
    );
  });

  it('leaves compiler jobs failed and retryable when runtime configuration is absent', async () => {
    const list = taskList();
    await expect(
      list['kf.compile_document']?.({
        actionId: '01940000-0000-8000-8000-000000000001',
      }),
    ).rejects.toThrow(/not configured/);
  });
});
