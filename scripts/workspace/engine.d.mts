// Types for engine.mjs, for the TypeScript that imports it (tests/deployment/workspace.test.ts).
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}
export interface RunOptions {
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly onLine?: (line: string) => void;
  readonly cwd?: string;
}
export type Run = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;
export interface EngineDeps {
  home?: string;
  env?: Record<string, string | undefined>;
  run?: Run;
  probe?: (url: string, timeoutMs?: number) => Promise<boolean>;
  log?: (line: string) => void;
  step?: (id: string, label: string) => void;
  loadBootstrap?: () => Promise<unknown>;
  askPassword?: (username: string) => Promise<string | undefined>;
  lamuBin?: string;
  embedModelDir?: string;
}
export declare const REPO: string;
export declare const UNIT: string;
export declare function runCommand(
  command: string,
  args: readonly string[],
  options?: RunOptions,
): Promise<RunResult>;
export declare function generatedPassword(file: string): Promise<string>;
export declare function startWorkspace(
  request: Record<string, string | undefined>,
  deps?: EngineDeps,
): Promise<{
  record: Record<string, unknown>;
  semantic: boolean;
  stack: 'up' | 'resume' | 'none';
  imported?: unknown;
}>;
export declare function stopWorkspace(deps?: EngineDeps): Promise<void>;
export declare function statusWorkspace(deps?: EngineDeps): Promise<unknown>;
export declare function resetWorkspace(
  options: { yes?: boolean },
  deps?: EngineDeps,
): Promise<void>;
export declare function workspaceAnswering(deps?: EngineDeps): Promise<boolean>;
export declare function workspaceExists(deps?: EngineDeps): Promise<boolean>;
