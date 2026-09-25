// Types for stack.mjs, for the TypeScript that imports it (tests/deployment).
export interface StackSettings {
  readonly state: string;
  readonly api: string;
  readonly web: string;
  readonly keycloak: string;
  readonly ownerUrl: string;
  readonly oidc: { issuer: string; clientId: string; redirectUri: string };
}
export declare const REALM: string;
export declare function stackSettings(env?: Record<string, string | undefined>): StackSettings;
export declare function personasFile(
  corpus: string,
  env?: Record<string, string | undefined>,
): string;
