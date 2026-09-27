// Types for overlay-source.mjs, for the TypeScript that imports it (tests/deployment).
import type { Classification } from '../lib/fixture-types.mjs';
export declare const CORPUS: string;
export declare const COMPANIES: Readonly<
  Record<string, { slug: string; legal_name: string; office: string; username_prefix: string }>
>;
export declare const SAMPLE_TASKS: readonly string[];
export declare function classify(about: string): { classification: Classification; rule: string };
