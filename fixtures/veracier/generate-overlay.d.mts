// Types for generate-overlay.mjs, for the TypeScript that imports it (tests/deployment).
export declare function classify(
  entity: string,
  relPath: string,
): { match: string; entity?: string; classification: string; why: string };
export declare function headingOf(text: string): string | undefined;
