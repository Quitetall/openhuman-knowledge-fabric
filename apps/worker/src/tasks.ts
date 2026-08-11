/**
 * The worker's task registry.
 *
 * Tasks are the asynchronous half of the action model: an action commits its domain change
 * and an outbox row in one transaction, and the worker delivers that outbox row afterwards.
 * A task therefore may retry, and must be written to be safe when it does.
 */

export type TaskHandler = (payload: unknown) => Promise<void>;

export interface TaskDefinition {
  readonly name: string;
  readonly description: string;
  readonly handler: TaskHandler;
}

/**
 * Liveness task. Exists so the runner has something real to execute before the outbox does,
 * and so a deployment can prove end-to-end job delivery without side effects.
 */
const echo: TaskDefinition = {
  name: 'kf.echo',
  description: 'No-op task used to verify job delivery end to end',
  handler: async () => {},
};

export const TASKS: readonly TaskDefinition[] = [echo];

export function taskList(): Record<string, TaskHandler> {
  const list: Record<string, TaskHandler> = {};
  for (const task of TASKS) {
    if (list[task.name]) {
      // Two handlers registered under one name means one silently never runs.
      throw new Error(`duplicate task name: ${task.name}`);
    }
    list[task.name] = task.handler;
  }
  return list;
}
