import { isLineageMemberRole, isOpaqueReferenceToken, isSha256 } from '@kf/ml-registry/contracts';

export interface MlRunSearchParams {
  readonly afterSequence?: string;
  readonly limit?: string;
  readonly afterMember?: string;
  readonly memberLimit?: string;
  readonly afterOrdinal?: string;
  readonly segmentLimit?: string;
  readonly afterReceiptDigest?: string;
  readonly promotionLimit?: string;
}

export interface RunRoute {
  readonly authorityId: string;
  readonly revisionId: string;
  readonly path: string;
}

function opaqueToken(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return isOpaqueReferenceToken(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function pageLimit(value: string | undefined): number {
  const parsed = Number(value ?? 100);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : 100;
}

export function parseRunRoute(route: {
  readonly authorityId: string;
  readonly revisionId: string;
}): RunRoute | undefined {
  const authorityId = opaqueToken(route.authorityId);
  const revisionId = opaqueToken(route.revisionId);
  return authorityId === undefined || revisionId === undefined
    ? undefined
    : {
        authorityId,
        revisionId,
        path: `/ml/runs/${authorityId}/revisions/${revisionId}`,
      };
}

export function projectionQuery(query: MlRunSearchParams): URLSearchParams {
  const endpoint = new URLSearchParams({
    limit: String(pageLimit(query.limit)),
    memberLimit: String(pageLimit(query.memberLimit)),
    segmentLimit: String(pageLimit(query.segmentLimit)),
    promotionLimit: String(pageLimit(query.promotionLimit)),
  });
  if (/^\d+$/.test(query.afterSequence ?? '')) endpoint.set('afterSequence', query.afterSequence!);
  const memberMatch = /^([^:]+):[1-9]\d*$/.exec(query.afterMember ?? '');
  if (memberMatch !== null && isLineageMemberRole(memberMatch[1])) {
    endpoint.set('afterMember', query.afterMember!);
  }
  if (/^\d+$/.test(query.afterOrdinal ?? '')) endpoint.set('afterOrdinal', query.afterOrdinal!);
  if (isSha256(query.afterReceiptDigest)) {
    endpoint.set('afterReceiptDigest', query.afterReceiptDigest!);
  }
  return endpoint;
}

export function paginationHref(
  routePath: string,
  query: URLSearchParams,
  changes: Readonly<Record<string, string>>,
): string {
  const target = new URLSearchParams(query);
  for (const [name, value] of Object.entries(changes)) target.set(name, value);
  return `${routePath}?${target}`;
}
