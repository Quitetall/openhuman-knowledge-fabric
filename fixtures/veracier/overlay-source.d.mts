// Types for overlay-source.mjs, for the TypeScript that imports it (tests/deployment).
export declare const LEGAL_NAME: string;
export declare const ENTITIES: Readonly<
  Record<string, { name: string; short: string; site: string; country: string }>
>;
export declare const CLASSIFICATION_RULES: ReadonlyArray<{
  match: string;
  entity?: string;
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
  why: string;
}>;
export declare const DEPARTMENT_FOLDERS: Readonly<Record<string, readonly string[]>>;
export declare const USE_CASE_FOLDERS: Readonly<Record<string, readonly string[]>>;
export declare const ASKERS: Readonly<Record<string, Record<string, unknown>>>;
export declare const STAFF: ReadonlyArray<Record<string, unknown>>;
export declare const NAME_POOLS: Readonly<Record<string, Record<string, readonly string[]>>>;
