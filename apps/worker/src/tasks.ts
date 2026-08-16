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

export interface TaskRuntime {
  readonly compileDocument: (actionId: string) => Promise<unknown>;
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

const compileDocumentUnavailable: TaskHandler = async () => {
  throw new Error('document compiler runtime is not configured');
};

const compileDocument: TaskDefinition = {
  name: 'kf.compile_document',
  description: 'Compile one exact finalized document Basis under its recorded request authority',
  handler: compileDocumentUnavailable,
};

export const TASKS: readonly TaskDefinition[] = [echo, compileDocument];

function compilerActionId(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('compiler task payload must be an object with actionId');
  }
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record['actionId'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record['actionId'],
    )
  ) {
    throw new Error('compiler task payload actionId must be one UUID and no other fields');
  }
  return record['actionId'];
}

export function taskList(runtime?: Partial<TaskRuntime>): Record<string, TaskHandler> {
  const list: Record<string, TaskHandler> = {};
  for (const task of TASKS) {
    if (list[task.name]) {
      // Two handlers registered under one name means one silently never runs.
      throw new Error(`duplicate task name: ${task.name}`);
    }
    list[task.name] =
      task.name === 'kf.compile_document' && runtime?.compileDocument !== undefined
        ? async (payload) => {
            await runtime.compileDocument!(compilerActionId(payload));
          }
        : task.handler;
  }
  return list;
}
