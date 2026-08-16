import { record } from './validation';

interface CallerContext {
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly organizationId: string;
  readonly maxClassification: string;
}

export type Caller =
  | (CallerContext & {
      readonly authentication: 'development';
    })
  | (CallerContext & {
      readonly authentication: 'oidc';
      readonly bearerToken: string;
    });

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;

  constructor(status: number, code: string, message: string, detail: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** Whether the caller can act on this refusal, rather than an internal fault. */
  get isRefusal(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export function apiBaseUrl(): string {
  const url = process.env['KF_API_URL'];
  if (url === undefined || url === '') {
    throw new Error('KF_API_URL is not set; the web application has no API to talk to');
  }
  return url.replace(/\/$/, '');
}

export function callerHeaders(caller: Caller): Record<string, string> {
  const context = {
    'content-type': 'application/json',
    'x-kf-acting-role': caller.actingRoleId,
    'x-kf-organization': caller.organizationId,
    'x-kf-classification': caller.maxClassification,
  };
  return caller.authentication === 'oidc'
    ? { ...context, authorization: `Bearer ${caller.bearerToken}` }
    : { ...context, 'x-kf-actor': caller.actorId };
}

export async function parseResponse(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => ({}));
  if (response.ok) return body;
  const error = record(body) ?? {};
  throw new ApiError(
    response.status,
    typeof error['error'] === 'string' ? error['error'] : 'unknown_error',
    typeof error['message'] === 'string' ? error['message'] : response.statusText,
    error['detail'],
  );
}

export type Decoder<T> = (value: unknown) => T;

export function decodeSuccessfulResponse<T>(body: unknown, decoder: Decoder<T>): T {
  try {
    return decoder(body);
  } catch {
    throw new ApiError(
      502,
      'invalid_api_response',
      'API response did not match its contract.',
      undefined,
    );
  }
}

export async function get<T>(path: string, caller: Caller, decoder: Decoder<T>): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    headers: callerHeaders(caller),
    // Controlled records change by action; never render a cached lifecycle decision.
    cache: 'no-store',
  });
  return decodeSuccessfulResponse(await parseResponse(response), decoder);
}
