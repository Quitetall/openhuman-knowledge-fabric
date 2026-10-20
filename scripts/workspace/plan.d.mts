// Types for plan.mjs, for the TypeScript that imports it (tests/deployment/workspace.test.ts).
export declare const PROJECT: string;
export declare const PORTS: Readonly<{
  web: number;
  api: number;
  keycloak: number;
  postgres: number;
  objects: number;
}>;
export declare const EMBED_CANDIDATES: readonly string[];
export declare const FOUNDER_AUTHORITY: Readonly<{
  roles: readonly string[];
  clearance: string;
  importClassification: string;
}>;
export declare const IMPORT_CEILING: number;
export interface WorkspacePaths {
  readonly state: string;
  readonly record: string;
  readonly passwordFile: string;
  readonly launcher: string;
}
export declare function workspacePaths(home?: string): WorkspacePaths;
export declare class WorkspaceError extends Error {
  constructor(code: string, message: string, advice?: string);
  readonly code: string;
  readonly advice: string;
}
export declare function usage(): string;
export interface ParsedArgs {
  readonly command: 'start' | 'stop' | 'status' | 'reset' | 'help';
  readonly options: Record<string, string | boolean | undefined>;
}
export declare function parseWorkspaceArgs(argv: readonly string[]): ParsedArgs;
export interface Identity {
  readonly organization: string;
  readonly name: string;
  readonly username: string;
  readonly email: string;
}
export declare function validateIdentity(input: {
  organization?: string;
  name?: string;
  username?: string;
  email?: string;
}): Identity;
export declare function passwordProblems(
  password: unknown,
  confirm: unknown,
  who: { username?: string; email?: string },
): string[];
export interface StartDecision {
  readonly identity: Identity;
  readonly stack: 'up' | 'resume' | 'none';
  readonly stopFirst: boolean;
  readonly bootstrap: boolean;
}
export declare function decideStart(input: {
  record: Record<string, unknown> | null;
  request: Record<string, string | undefined>;
  apps: Record<string, boolean>;
  containers: boolean;
}): StartDecision;
export interface PortConflict {
  readonly name: string;
  readonly port: number;
  readonly purpose: string;
}
export declare function portConflicts(listening: Set<number>, owned: Set<number>): PortConflict[];
export declare function ownedPorts(
  apps: Record<string, boolean>,
  containerPorts: readonly number[],
): Set<number>;
export declare function portRefusal(conflicts: readonly PortConflict[]): WorkspaceError;
export declare function listeningPorts(ssOutput: string): Set<number>;
export declare function publishedPorts(dockerPorts: string): number[];
export declare function appsRunning(statusOutput: string): Record<string, boolean>;
export declare function stackEnv(
  base: Record<string, string | undefined>,
  options: {
    state: string;
    organization?: string;
    embedUrl?: string;
    skipBuild?: boolean;
    agent?: Record<string, string>;
  },
): Record<string, string | undefined>;
export declare function settingsFor(state: string): Record<string, unknown>;
export declare function nextSteps(input: {
  identity: Identity;
  passwordFile?: string;
  semantic: boolean;
  imported?: string;
}): string;
