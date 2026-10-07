// Types for roles.mjs (Véracier's role presets, ADR 0040).
export declare const ROLE_DEFINITIONS: readonly (readonly [string, string])[];
export declare const TEAMS: Readonly<Record<string, readonly string[]>>;
export declare const INCLUSIONS: readonly (readonly [string, string])[];
export declare const ORGANIZATION_WIDE: readonly (readonly [string, string])[];
export declare function holders(
  people: readonly {
    readonly key: string;
    readonly persona?: string | null;
    readonly entity: string;
    readonly ceiling: string;
  }[],
): Map<string, Set<string>>;
export declare function teamOf(readers: readonly string[] | undefined): string | undefined;
