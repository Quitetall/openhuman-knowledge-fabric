/**
 * The Fabric API as the in-app agent reaches it: every call carries the person's token — exchanged
 * for the in-app agent's when the deployment declared one (ADR 0035) — and nothing else. The agent
 * has no database login and no authority of its own; every decision and every refusal is the API's.
 *
 * The shape is the KF MCP server's `FabricApi` (apps/mcp/src/api.ts), so the two agent surfaces
 * are clients of one enforcement path in the same way.
 */

export interface ApiAnswer {
  readonly status: number;
  readonly body: unknown;
}

export interface FabricClient {
  readonly organizationId: string;
  call(
    method: 'GET' | 'POST',
    path: string,
    options?: { readonly query?: Record<string, string>; readonly body?: unknown },
  ): Promise<ApiAnswer>;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The API's refusal code (`error`), when the body has one. */
export function refusalCode(answer: ApiAnswer): string | undefined {
  const error = record(answer.body)?.['error'];
  return typeof error === 'string' ? error : undefined;
}

/** The context source's rule (`KF-CTX-…`), when the body has one. */
export function refusalRule(answer: ApiAnswer): string | undefined {
  const rule = record(answer.body)?.['rule'];
  return typeof rule === 'string' ? rule : undefined;
}
