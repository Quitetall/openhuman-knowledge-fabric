// Types for server.mjs, for the TypeScript that imports it (tests/deployment/workspace.test.ts).
import type { Server } from 'node:http';
import type { AnswersInput } from './answers.mjs';
export interface LauncherProgress {
  state: 'idle' | 'running' | 'ready' | 'failed';
  steps: { id: string; label: string }[];
  error?: { message: string; advice: string };
  imported?: unknown;
}
export declare function createLauncherServer(options: {
  token: string;
  mode: 'setup' | 'start';
  start: (
    request: Record<string, unknown>,
    hooks: { step: (id: string, label: string) => void; log: (line: string) => void },
  ) => Promise<unknown>;
  /** The engine's AI-answers face (engine.mjs answersState, applyAnswers). */
  answers?: {
    state: () => Promise<unknown>;
    apply: (input: AnswersInput) => Promise<{ restarted: boolean }>;
  };
  log?: (line: string) => void;
  homeUrl?: string;
}): {
  server: Server;
  progress: LauncherProgress;
  listen: () => Promise<string>;
  close: () => Promise<void>;
};
