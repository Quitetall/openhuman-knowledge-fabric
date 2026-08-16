import {
  ApiError,
  apiBaseUrl,
  callerHeaders,
  decodeSuccessfulResponse,
  parseResponse,
  type Caller,
} from './client';
import { hasStrings, record } from './validation';

export type OperationalCheckStatus = 'ok' | 'degraded' | 'failed' | 'unknown';

export type OperationalReadinessScope = 'service' | 'institutional';

export interface OperationalReadinessCheck {
  readonly id: string;
  readonly scope: OperationalReadinessScope;
  readonly status: OperationalCheckStatus;
  readonly detail: string;
  readonly measured?: Readonly<Record<string, number | string | null>>;
}

export interface OperationalReadinessPartition {
  readonly ready: boolean;
  readonly checks: readonly OperationalReadinessCheck[];
}

export interface OperationalReadinessReport {
  /** Compatibility alias for `service.ready`. */
  readonly ready: boolean;
  /** Compatibility alias for `service.checks`. */
  readonly checks: readonly OperationalReadinessCheck[];
  readonly service: OperationalReadinessPartition;
  readonly institutional: OperationalReadinessPartition;
}

function operationalReadinessCheck(
  candidate: unknown,
  scope: OperationalReadinessScope,
): candidate is OperationalReadinessCheck {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  const check = candidate as Record<string, unknown>;
  const measured = check['measured'];
  const measuredValid =
    measured === undefined ||
    (measured !== null &&
      typeof measured === 'object' &&
      !Array.isArray(measured) &&
      Object.values(measured).every(
        (fact) =>
          fact === null ||
          typeof fact === 'string' ||
          (typeof fact === 'number' && Number.isFinite(fact)),
      ));
  return (
    typeof check['id'] === 'string' &&
    check['id'] !== '' &&
    check['scope'] === scope &&
    ['ok', 'degraded', 'failed', 'unknown'].includes(String(check['status'])) &&
    typeof check['detail'] === 'string' &&
    check['detail'] !== '' &&
    measuredValid
  );
}

function operationalReadinessPartition(
  value: unknown,
  scope: OperationalReadinessScope,
): value is OperationalReadinessPartition {
  const partition = record(value);
  if (
    partition === undefined ||
    typeof partition['ready'] !== 'boolean' ||
    !Array.isArray(partition['checks']) ||
    partition['checks'].length === 0 ||
    !partition['checks'].every((candidate) => operationalReadinessCheck(candidate, scope))
  ) {
    return false;
  }
  return partition['ready'] === partition['checks'].every((check) => check.status === 'ok');
}

function measurementsEqual(
  left: Readonly<Record<string, number | string | null>> | undefined,
  right: Readonly<Record<string, number | string | null>> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([key, value]) => right[key] === value)
  );
}

function operationalReadinessReport(value: unknown): value is OperationalReadinessReport {
  const report = record(value);
  if (
    report === undefined ||
    !operationalReadinessPartition(report['service'], 'service') ||
    !operationalReadinessPartition(report['institutional'], 'institutional') ||
    typeof report['ready'] !== 'boolean' ||
    !Array.isArray(report['checks'])
  ) {
    return false;
  }
  const service = report['service'];
  return (
    report['ready'] === service.ready &&
    report['checks'].length === service.checks.length &&
    report['checks'].every((candidate, index) => {
      const expected = service.checks[index];
      return (
        expected !== undefined &&
        operationalReadinessCheck(candidate, 'service') &&
        candidate.id === expected.id &&
        candidate.status === expected.status &&
        candidate.detail === expected.detail &&
        measurementsEqual(candidate.measured, expected.measured)
      );
    })
  );
}

/** Accept both ready and fail-closed readiness evidence after validating the response shape. */
export async function getOperationalReadiness(): Promise<OperationalReadinessReport> {
  const response = await fetch(`${apiBaseUrl()}/readiness`, { cache: 'no-store' });
  const body: unknown = await response.json().catch(() => undefined);
  if (operationalReadinessReport(body)) {
    const statusMatchesServiceVerdict = body.service.ready ? response.ok : response.status === 503;
    if (statusMatchesServiceVerdict) return body;
  }
  if (!response.ok) {
    const error = record(body) ?? {};
    throw new ApiError(
      response.status,
      typeof error['error'] === 'string' ? error['error'] : 'readiness_unavailable',
      typeof error['message'] === 'string'
        ? error['message']
        : 'Operational readiness could not be measured.',
      error['detail'],
    );
  }
  throw new ApiError(
    502,
    'invalid_readiness_response',
    'Operational readiness response did not match its contract.',
    undefined,
  );
}

export interface ActionOutcome {
  readonly actionId: string;
  readonly replayed: boolean;
  readonly objectIds: readonly string[];
  readonly auditDigest: string;
}

function parseActionOutcome(value: unknown): ActionOutcome {
  const outcome = record(value);
  if (
    outcome === undefined ||
    !hasStrings(outcome, ['actionId', 'auditDigest']) ||
    typeof outcome['replayed'] !== 'boolean' ||
    !Array.isArray(outcome['objectIds']) ||
    !outcome['objectIds'].every((id) => typeof id === 'string')
  ) {
    throw new Error('action outcome did not match contract');
  }
  return outcome as unknown as ActionOutcome;
}

export async function act(
  actionType: string,
  body: {
    targetIds?: readonly string[];
    payload?: Record<string, unknown>;
    reason?: string;
    idempotencyKey: string;
    expectedVersion?: number;
  },
  caller: Caller,
): Promise<ActionOutcome> {
  const response = await fetch(`${apiBaseUrl()}/actions/${encodeURIComponent(actionType)}`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: JSON.stringify(body),
  });
  return decodeSuccessfulResponse(await parseResponse(response), parseActionOutcome);
}

export interface AddDocumentInput {
  readonly title: string;
  readonly documentNumber: string;
  readonly revision: string;
  readonly documentClass: string;
  readonly owningRole: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly contentBase64: string;
  readonly idempotencyKey: string;
}

export interface AddDocumentOutcome {
  readonly id: string;
  readonly artifactId: string;
  readonly sha256: string;
  readonly replayed: boolean;
}

function parseAddDocumentOutcome(value: unknown): AddDocumentOutcome {
  const outcome = record(value);
  if (
    outcome === undefined ||
    !hasStrings(outcome, ['id', 'artifactId', 'sha256']) ||
    typeof outcome['replayed'] !== 'boolean'
  ) {
    throw new Error('document import outcome did not match contract');
  }
  return outcome as unknown as AddDocumentOutcome;
}

export async function addDocument(
  input: AddDocumentInput,
  caller: Caller,
): Promise<AddDocumentOutcome> {
  const response = await fetch(`${apiBaseUrl()}/documents`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: JSON.stringify(input),
  });
  return decodeSuccessfulResponse(await parseResponse(response), parseAddDocumentOutcome);
}
