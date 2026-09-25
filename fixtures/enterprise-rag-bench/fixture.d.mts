// Types for fixture.mjs, for the TypeScript that imports it (tests/deployment).
import type { Fixture } from '../lib/fixture-types.mjs';
export declare const SAMPLE_DIR: string;
export declare function fixture(options: {
  sample: boolean;
  full?: boolean;
  data?: string;
}): Promise<
  Fixture & {
    raw: ReadonlyArray<{
      key: string;
      doc_id: string;
      source_type: string;
      source_path: string;
      classification: string;
      expected: boolean;
    }>;
  }
>;
