// Types for fixture.mjs, for the TypeScript that imports it (tests/deployment).
import type { Fixture, Person } from '../lib/fixture-types.mjs';
export declare const SAMPLE_DIR: string;
export interface Company {
  readonly name: string;
  readonly company: { slug: string; legal_name: string };
  readonly people: readonly Person[];
  readonly tasks: ReadonlyArray<{ task: string; files: readonly string[]; question: string }>;
  readonly documents: ReadonlyArray<{ key: string; format: string; qa_type: string }>;
}
export declare function companiesIn(dir: string): Promise<Company[]>;
export declare function fixtureOf(company: Company, dir: string): Fixture;
