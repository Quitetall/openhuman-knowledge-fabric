// Types for lock.mjs, for the TypeScript that imports it (tests/deployment/workspace.test.ts).
export interface LockHolder {
  readonly pid: number;
  readonly data: string;
}
export declare function lockHolder(file: string): LockHolder | undefined;
export declare function acquireLock(
  file: string,
  data?: string,
): { acquired: true; release: () => void } | { acquired: false; holder: LockHolder };
