// Types for overlay-source.mjs, for the TypeScript that imports it (tests/deployment).
import type { Classification } from '../lib/fixture-types.mjs';
export declare const CORPUS: string;
export declare const LEGAL_NAME: string;
export declare const FOUNDER: string;
export declare const OFFICE: string;
export declare const USERNAME_PREFIX: string;
export declare const CLASSIFICATION_RULES: ReadonlyArray<{
  match: string;
  mailbox?: string;
  classification: Classification;
  why: string;
}>;
export declare const DEPARTMENT_FOLDERS: Readonly<Record<string, readonly string[]>>;
export declare function nameKey(name: string): string;
export declare function authorityOf(
  department: string,
  title: string,
): { tier: string; role: string; clearance: Classification; ceiling: Classification };
export declare function mailboxOwner(sourcePath: string): string | undefined;
export declare function mailParticipants(
  content: string,
  peopleByName: ReadonlyMap<string, string>,
): string[];
