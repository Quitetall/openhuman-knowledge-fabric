/**
 * The API client. The web app's ONLY way to reach a record.
 *
 * No database connection lives in this application, deliberately. Two paths to the same
 * records would mean two places where authority is decided, and the second one is always the
 * one that skips a check — so the web app is a client of the API exactly like any other
 * caller, and gets refused by the same rules.
 */

export interface Caller {
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly organizationId: string;
  readonly maxClassification: string;
}

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

  /**
   * Whether the caller can do something about this.
   *
   * A refusal is a fact about the record — the state moved, the ceiling is exhausted, someone
   * else must approve it — and the interface should say so. A fault is our problem and should
   * say only that.
   */
  get isRefusal(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

function baseUrl(): string {
  const url = process.env['KF_API_URL'];
  if (url === undefined || url === '') {
    throw new Error('KF_API_URL is not set; the web application has no API to talk to');
  }
  return url.replace(/\/$/, '');
}

function headers(caller: Caller): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-kf-actor': caller.actorId,
    'x-kf-acting-role': caller.actingRoleId,
    'x-kf-organization': caller.organizationId,
    'x-kf-classification': caller.maxClassification,
  };
}

async function parse(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return body;
  throw new ApiError(
    response.status,
    typeof body['error'] === 'string' ? body['error'] : 'unknown_error',
    typeof body['message'] === 'string' ? body['message'] : response.statusText,
    body['detail'],
  );
}

export async function get<T>(path: string, caller: Caller): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    headers: headers(caller),
    // Controlled records change by action, and a page showing a stale lifecycle state is
    // worse than a slow one — someone acts on what they see.
    cache: 'no-store',
  });
  return (await parse(response)) as T;
}

export interface ActionOutcome {
  readonly actionId: string;
  readonly replayed: boolean;
  readonly objectIds: readonly string[];
  readonly auditDigest: string;
}

export async function act(
  actionType: string,
  body: {
    targetIds?: readonly string[];
    payload?: Record<string, unknown>;
    reason?: string;
    /**
     * Supplied by the CALLER, not generated here per attempt. A form submitted twice by an
     * impatient user is one logical attempt; a key minted per request would make it two.
     */
    idempotencyKey: string;
    expectedVersion?: number;
  },
  caller: Caller,
): Promise<ActionOutcome> {
  const response = await fetch(`${baseUrl()}/actions/${encodeURIComponent(actionType)}`, {
    method: 'POST',
    headers: headers(caller),
    body: JSON.stringify(body),
  });
  return (await parse(response)) as ActionOutcome;
}

// ── read shapes ─────────────────────────────────────────────────────────────────────────

export interface ProjectView {
  readonly id: string;
  readonly enterprise_id: string | null;
  readonly title: string;
  readonly lifecycle_state: string;
  readonly row_version: string;
  readonly project_code: string | null;
  readonly objective: string;
  readonly sponsor_id: string;
  readonly started_on: string | null;
  readonly target_completion: string | null;
  readonly packages: readonly {
    readonly id: string;
    readonly title: string;
    readonly lifecycle_state: string;
    readonly sequence_no: number;
    readonly acceptance_criterion: string;
  }[];
  readonly progress: {
    readonly totalPackages: number;
    readonly disposedPackages: number;
    readonly fraction: number | null;
  };
}

export interface HistoryView {
  readonly objectId: string;
  readonly events: readonly {
    readonly seq: string;
    readonly action_type: string;
    readonly actor_id: string;
    readonly acting_role_id: string;
    readonly recorded_at: string;
    readonly effective_at: string;
    readonly reason: string | null;
    readonly digest: string;
  }[];
}
