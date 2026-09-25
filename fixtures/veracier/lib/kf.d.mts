// Types for kf.mjs, for the TypeScript that imports it (tests/deployment).
export declare class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
}
export declare class PersonaSession {
  constructor(options: {
    oidc: { issuer: string; clientId: string; redirectUri: string };
    apiOrigin: string;
    person: { username?: string; key: string; clearance: string };
    password: string | undefined;
    organizationId: string;
    assignmentId: string;
  });
  token(): Promise<string>;
  request(
    method: string,
    route: string,
    body?: unknown,
    options?: { classification?: string; attempts?: number },
  ): Promise<{ status: number; body: unknown }>;
  act(actionType: string, request: unknown): Promise<{ status: number; body: unknown }>;
}
export declare function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]>;
export declare function ownerSession(repo: string, ownerUrl: string): unknown;
