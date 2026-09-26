// Types for fixture.mjs, for the TypeScript that imports it (tests/deployment).
import type { Fixture } from '../lib/fixture-types.mjs';
export declare function fixture(options: {
  sample: boolean;
  data?: string;
}): Promise<Fixture & { raw: ReadonlyArray<{ key: string; path: string; format: string }> }>;
