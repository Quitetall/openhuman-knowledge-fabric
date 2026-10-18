// Types for server.mjs, for the TypeScript that imports it (tests/deployment/workspace.test.ts).
import type { Server } from 'node:http';
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
    request: Record<string, string | undefined>,
    hooks: { step: (id: string, label: string) => void; log: (line: string) => void },
  ) => Promise<unknown>;
  log?: (line: string) => void;
  homeUrl?: string;
}): {
  server: Server;
  progress: LauncherProgress;
  listen: () => Promise<string>;
  close: () => Promise<void>;
};
