// Types for overlay-source.mjs, for the TypeScript that imports it (tests/deployment).
import type { Classification, Person } from '../lib/fixture-types.mjs';
export declare const CORPUS: string;
export declare const PEOPLE: readonly Person[];
export declare const SAMPLE_PATHS: readonly string[];
export declare const CLASSIFICATION_RULES: ReadonlyArray<{
  match: string;
  classification: Classification;
  why: string;
}>;
export declare function classify(relPath: string): { classification: Classification; rule: string };
export declare function included(relPath: string): boolean;
