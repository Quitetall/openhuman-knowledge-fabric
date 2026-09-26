// Types for organizations.mjs, for the TypeScript that imports it (tests/deployment).
import type { StackSettings } from '../lib/stack.mjs';

export interface FixturePerson {
  readonly key: string;
  readonly name: string;
  readonly username: string;
  readonly role: string;
  readonly clearance: string;
  readonly ceiling: string;
  readonly persona?: string;
}
export interface FixtureOrganization {
  readonly id: string;
  readonly personasCorpus: string;
  readonly legalName: string;
  readonly people: readonly FixturePerson[];
  readonly strong: string;
  readonly documents: ReadonlyArray<{ key: string; title: string; text: string }>;
}
export declare function organizations(settings?: StackSettings): Promise<FixtureOrganization[]>;
export declare function probeTable(
  orgs: readonly FixtureOrganization[],
  options?: { settings?: StackSettings; count?: number },
): Promise<Map<string, string[]>>;
