import { notFound } from 'next/navigation';
import { ApiError, get } from '../../../../../../lib/api';
import { webCaller } from '../../../../../../lib/session';

const OPAQUE_REFERENCE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

interface AggregateReference {
  readonly kind: string;
  readonly authorityId: string;
  readonly revisionId: string;
  readonly sha256: string;
  readonly classificationId: string;
  readonly policyId: string;
}

interface MetricEvent {
  readonly sequence: string;
  readonly recordedAt: string;
  readonly status: string;
  readonly metricId: string;
  readonly unitId: string | null;
  readonly value:
    | { readonly kind: 'number'; readonly number: number }
    | { readonly kind: 'safe_enum'; readonly enumId: string }
    | { readonly kind: 'timestamp'; readonly timestamp: string };
  readonly eventDigest: string;
}

interface Promotion {
  readonly aliasId: string;
  readonly candidate: AggregateReference;
  readonly policy: AggregateReference;
  readonly riskTier: string;
  readonly technicalAuthorityDecision: AggregateReference;
  readonly qualityAuthorityDecision: AggregateReference | null;
  readonly promotedAt: string;
  readonly receiptDigest: string;
  readonly status: 'recorded' | 'revoked';
  readonly revocation: null | {
    readonly reasonCode: string;
    readonly revokedAt: string;
  };
}

interface RunProjection {
  readonly schemaVersion: 'kf.ml.run-projection.v1';
  readonly run: AggregateReference;
  readonly lineage: {
    readonly lineageDigest: string;
    readonly recordedAt: string;
    readonly code: AggregateReference;
    readonly recipe: AggregateReference;
    readonly environment: AggregateReference;
    readonly metricPolicy: AggregateReference;
    readonly members: {
      readonly items: readonly {
        readonly role: 'input' | 'output' | 'parent_model';
        readonly ordinal: number;
        readonly reference: AggregateReference;
      }[];
      readonly page: {
        readonly limit: number;
        readonly afterMember: string | null;
        readonly nextAfterMember: string | null;
      };
    };
  };
  readonly metrics: {
    readonly events: readonly MetricEvent[];
    readonly page: {
      readonly limit: number;
      readonly afterSequence: string;
      readonly nextAfterSequence: string | null;
    };
  };
  readonly segments: {
    readonly items: readonly {
      readonly reference: AggregateReference;
      readonly ordinal: number;
      readonly firstSequence: string;
      readonly lastSequence: string;
      readonly eventCount: string;
      readonly metadataDigest: string;
    }[];
    readonly page: {
      readonly limit: number;
      readonly afterOrdinal: number;
      readonly nextAfterOrdinal: number | null;
    };
  };
  readonly seal: null | {
    readonly lineageDigest: string;
    readonly segmentManifestDigest: string;
    readonly eventCount: string;
    readonly sealedAt: string;
    readonly signingKeyId: string;
    readonly sealDigest: string;
    readonly recordedAt: string;
  };
  readonly promotions: {
    readonly receipts: readonly Promotion[];
    readonly page: {
      readonly limit: number;
      readonly afterReceiptDigest: string | null;
      readonly nextAfterReceiptDigest: string | null;
    };
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasStrings(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

function isReference(value: unknown): value is AggregateReference {
  const ref = record(value);
  return (
    ref !== undefined &&
    hasStrings(ref, ['kind', 'authorityId', 'revisionId', 'sha256', 'classificationId', 'policyId'])
  );
}

function isMetricEvent(value: unknown): value is MetricEvent {
  const event = record(value);
  const typed = record(event?.['value']);
  if (event === undefined || typed === undefined) return false;
  const validValue =
    (typed['kind'] === 'number' &&
      typeof typed['number'] === 'number' &&
      Number.isFinite(typed['number'])) ||
    (typed['kind'] === 'safe_enum' && typeof typed['enumId'] === 'string') ||
    (typed['kind'] === 'timestamp' && typeof typed['timestamp'] === 'string');
  return (
    hasStrings(event, ['sequence', 'recordedAt', 'status', 'metricId', 'eventDigest']) &&
    (event['unitId'] === null || typeof event['unitId'] === 'string') &&
    validValue
  );
}

function isPromotion(value: unknown): value is Promotion {
  const promotion = record(value);
  if (promotion === undefined) return false;
  const revocation = promotion['revocation'];
  return (
    hasStrings(promotion, ['aliasId', 'riskTier', 'promotedAt', 'receiptDigest']) &&
    ['recorded', 'revoked'].includes(String(promotion['status'])) &&
    isReference(promotion['candidate']) &&
    isReference(promotion['policy']) &&
    isReference(promotion['technicalAuthorityDecision']) &&
    (promotion['qualityAuthorityDecision'] === null ||
      isReference(promotion['qualityAuthorityDecision'])) &&
    (revocation === null ||
      (record(revocation) !== undefined &&
        hasStrings(record(revocation)!, ['reasonCode', 'revokedAt'])))
  );
}

function isProjection(value: unknown): value is RunProjection {
  const body = record(value);
  const lineage = record(body?.['lineage']);
  const members = record(lineage?.['members']);
  const memberPage = record(members?.['page']);
  const metrics = record(body?.['metrics']);
  const page = record(metrics?.['page']);
  const segments = record(body?.['segments']);
  const segmentPage = record(segments?.['page']);
  const promotions = record(body?.['promotions']);
  const promotionPage = record(promotions?.['page']);
  if (
    body === undefined ||
    lineage === undefined ||
    members === undefined ||
    memberPage === undefined ||
    metrics === undefined ||
    page === undefined ||
    segments === undefined ||
    segmentPage === undefined ||
    promotions === undefined ||
    promotionPage === undefined
  ) {
    return false;
  }
  const seal = body['seal'];
  return (
    body['schemaVersion'] === 'kf.ml.run-projection.v1' &&
    isReference(body['run']) &&
    hasStrings(lineage, ['lineageDigest', 'recordedAt']) &&
    isReference(lineage['code']) &&
    isReference(lineage['recipe']) &&
    isReference(lineage['environment']) &&
    isReference(lineage['metricPolicy']) &&
    Array.isArray(members['items']) &&
    members['items'].every((member) => {
      const item = record(member);
      return (
        item !== undefined &&
        ['input', 'output', 'parent_model'].includes(String(item['role'])) &&
        typeof item['ordinal'] === 'number' &&
        Number.isInteger(item['ordinal']) &&
        item['ordinal'] >= 1 &&
        isReference(item['reference'])
      );
    }) &&
    typeof memberPage['limit'] === 'number' &&
    Number.isInteger(memberPage['limit']) &&
    memberPage['limit'] >= 1 &&
    memberPage['limit'] <= 500 &&
    (memberPage['afterMember'] === null || typeof memberPage['afterMember'] === 'string') &&
    (memberPage['nextAfterMember'] === null || typeof memberPage['nextAfterMember'] === 'string') &&
    Array.isArray(metrics['events']) &&
    metrics['events'].every(isMetricEvent) &&
    typeof page['limit'] === 'number' &&
    Number.isInteger(page['limit']) &&
    page['limit'] >= 1 &&
    page['limit'] <= 500 &&
    typeof page['afterSequence'] === 'string' &&
    (page['nextAfterSequence'] === null || typeof page['nextAfterSequence'] === 'string') &&
    Array.isArray(segments['items']) &&
    segments['items'].every((segment) => {
      const row = record(segment);
      return (
        row !== undefined &&
        isReference(row['reference']) &&
        typeof row['ordinal'] === 'number' &&
        Number.isInteger(row['ordinal']) &&
        hasStrings(row, ['firstSequence', 'lastSequence', 'eventCount', 'metadataDigest'])
      );
    }) &&
    typeof segmentPage['limit'] === 'number' &&
    Number.isInteger(segmentPage['limit']) &&
    segmentPage['limit'] >= 1 &&
    segmentPage['limit'] <= 500 &&
    typeof segmentPage['afterOrdinal'] === 'number' &&
    Number.isInteger(segmentPage['afterOrdinal']) &&
    (segmentPage['nextAfterOrdinal'] === null ||
      (typeof segmentPage['nextAfterOrdinal'] === 'number' &&
        Number.isInteger(segmentPage['nextAfterOrdinal']))) &&
    (seal === null ||
      (record(seal) !== undefined &&
        hasStrings(record(seal)!, [
          'lineageDigest',
          'segmentManifestDigest',
          'eventCount',
          'sealedAt',
          'signingKeyId',
          'sealDigest',
          'recordedAt',
        ]))) &&
    Array.isArray(promotions['receipts']) &&
    promotions['receipts'].every(isPromotion) &&
    typeof promotionPage['limit'] === 'number' &&
    Number.isInteger(promotionPage['limit']) &&
    promotionPage['limit'] >= 1 &&
    promotionPage['limit'] <= 500 &&
    (promotionPage['afterReceiptDigest'] === null ||
      typeof promotionPage['afterReceiptDigest'] === 'string') &&
    (promotionPage['nextAfterReceiptDigest'] === null ||
      typeof promotionPage['nextAfterReceiptDigest'] === 'string')
  );
}

function metricValue(event: MetricEvent): string {
  if (event.value.kind === 'number') {
    return `${event.value.number}${event.unitId === null ? '' : ` ${event.unitId}`}`;
  }
  if (event.value.kind === 'safe_enum') return event.value.enumId;
  return event.value.timestamp;
}

function short(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function opaqueToken(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return OPAQUE_REFERENCE_TOKEN.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function pageLimit(value: string | undefined): number {
  const parsed = Number(value ?? 100);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : 100;
}

export const dynamic = 'force-dynamic';

export default async function MlRunPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ authorityId: string; revisionId: string }>;
  readonly searchParams: Promise<{
    afterSequence?: string;
    limit?: string;
    afterMember?: string;
    memberLimit?: string;
    afterOrdinal?: string;
    segmentLimit?: string;
    afterReceiptDigest?: string;
    promotionLimit?: string;
  }>;
}) {
  const route = await params;
  const authorityId = opaqueToken(route.authorityId);
  const revisionId = opaqueToken(route.revisionId);
  if (authorityId === undefined || revisionId === undefined) notFound();
  const routePath = `/ml/runs/${authorityId}/revisions/${revisionId}`;
  const query = await searchParams;
  const afterSequence = /^\d+$/.test(query.afterSequence ?? '') ? query.afterSequence : undefined;
  const afterMember = /^(?:input|output|parent_model):[1-9]\d*$/.test(query.afterMember ?? '')
    ? query.afterMember
    : undefined;
  const afterOrdinal = /^\d+$/.test(query.afterOrdinal ?? '') ? query.afterOrdinal : undefined;
  const afterReceiptDigest = /^[0-9a-f]{64}$/.test(query.afterReceiptDigest ?? '')
    ? query.afterReceiptDigest
    : undefined;
  const limit = pageLimit(query.limit);
  const memberLimit = pageLimit(query.memberLimit);
  const segmentLimit = pageLimit(query.segmentLimit);
  const promotionLimit = pageLimit(query.promotionLimit);
  const caller = await webCaller(routePath);
  const endpoint = new URLSearchParams({
    limit: String(limit),
    memberLimit: String(memberLimit),
    segmentLimit: String(segmentLimit),
    promotionLimit: String(promotionLimit),
  });
  if (afterSequence !== undefined) endpoint.set('afterSequence', afterSequence);
  if (afterMember !== undefined) endpoint.set('afterMember', afterMember);
  if (afterOrdinal !== undefined) endpoint.set('afterOrdinal', afterOrdinal);
  if (afterReceiptDigest !== undefined) endpoint.set('afterReceiptDigest', afterReceiptDigest);

  let projection: RunProjection;
  try {
    const value = await get<unknown>(`${routePath}?${endpoint}`, caller);
    if (!isProjection(value)) throw new Error('ML run projection did not match v1 contract');
    projection = value;
  } catch (error: unknown) {
    const hidden =
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403 || error.status === 404);
    return (
      <main style={{ maxWidth: '52rem', margin: '3rem auto', padding: '0 1.5rem' }}>
        <h1>
          {hidden
            ? 'Run unavailable under selected authority context'
            : 'Run projection unavailable'}
        </h1>
        <p>
          {hidden
            ? 'The selected authority context cannot read this run, or the run does not exist.'
            : 'Projection failed closed; no partial lineage or metrics are shown.'}
        </p>
      </main>
    );
  }

  const lineageReferences: readonly (readonly [string, AggregateReference])[] = [
    ['code', projection.lineage.code],
    ['recipe', projection.lineage.recipe],
    ['environment', projection.lineage.environment],
    ['metric policy', projection.lineage.metricPolicy],
    ...projection.lineage.members.items.map(
      (member) => [member.role.replace('_', ' '), member.reference] as const,
    ),
  ];
  const pageHref = (changes: Readonly<Record<string, string>>): string => {
    const target = new URLSearchParams(endpoint);
    for (const [name, value] of Object.entries(changes)) target.set(name, value);
    return `${routePath}?${target}`;
  };

  return (
    <main style={{ maxWidth: '72rem', margin: '2.5rem auto', padding: '0 1.5rem 5rem' }}>
      <p style={{ color: '#64748b', margin: 0 }}>ML RUN · {projection.schemaVersion}</p>
      <h1 style={{ marginTop: '0.25rem' }}>{projection.run.authorityId}</h1>
      <p>
        Revision {projection.run.revisionId} · {projection.run.classificationId} · policy{' '}
        {projection.run.policyId}
      </p>

      <section>
        <h2>Lineage</h2>
        <p style={{ fontFamily: 'monospace' }} title={projection.lineage.lineageDigest}>
          {short(projection.lineage.lineageDigest)}
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Role</th>
              <th align="left">Authority</th>
              <th align="left">Revision</th>
              <th align="left">Digest</th>
            </tr>
          </thead>
          <tbody>
            {lineageReferences.map(([role, ref], index) => (
              <tr
                key={`${role}-${ref.authorityId}-${index}`}
                style={{ borderTop: '1px solid #e2e8f0' }}
              >
                <td>{role}</td>
                <td>{ref.authorityId}</td>
                <td>{ref.revisionId}</td>
                <td title={ref.sha256}>{short(ref.sha256)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {projection.lineage.members.page.nextAfterMember === null ? null : (
          <a href={pageHref({ afterMember: projection.lineage.members.page.nextAfterMember })}>
            Next lineage member page
          </a>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Metric events</h2>
        {projection.metrics.events.length === 0 ? (
          <p>No events in this page.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th align="left">Sequence</th>
                <th align="left">Metric</th>
                <th align="left">Value</th>
                <th align="left">Status</th>
                <th align="left">Digest</th>
              </tr>
            </thead>
            <tbody>
              {projection.metrics.events.map((event) => (
                <tr key={event.sequence} style={{ borderTop: '1px solid #e2e8f0' }}>
                  <td>{event.sequence}</td>
                  <td>{event.metricId}</td>
                  <td>{metricValue(event)}</td>
                  <td>{event.status}</td>
                  <td title={event.eventDigest}>{short(event.eventDigest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {projection.metrics.page.nextAfterSequence === null ? null : (
          <a href={pageHref({ afterSequence: projection.metrics.page.nextAfterSequence })}>
            Next metric page
          </a>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Metric segments</h2>
        {projection.segments.items.length === 0 ? (
          <p>No segments in this page.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th align="left">Ordinal</th>
                <th align="left">Reference</th>
                <th align="left">Sequences</th>
                <th align="left">Events</th>
                <th align="left">Digest</th>
              </tr>
            </thead>
            <tbody>
              {projection.segments.items.map((segment) => (
                <tr key={segment.ordinal} style={{ borderTop: '1px solid #e2e8f0' }}>
                  <td>{segment.ordinal}</td>
                  <td>{segment.reference.authorityId}</td>
                  <td>
                    {segment.firstSequence}–{segment.lastSequence}
                  </td>
                  <td>{segment.eventCount}</td>
                  <td title={segment.metadataDigest}>{short(segment.metadataDigest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {projection.segments.page.nextAfterOrdinal === null ? null : (
          <a href={pageHref({ afterOrdinal: String(projection.segments.page.nextAfterOrdinal) })}>
            Next segment page
          </a>
        )}
      </section>

      <section
        style={{
          marginTop: '2rem',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '1rem',
        }}
      >
        <div style={{ border: '1px solid #cbd5e1', padding: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>Run seal</h2>
          {projection.seal === null ? (
            <p>Unsealed. Metrics remain provisional.</p>
          ) : (
            <dl>
              <dt>Events</dt>
              <dd>{projection.seal.eventCount}</dd>
              <dt>Key</dt>
              <dd>{projection.seal.signingKeyId}</dd>
              <dt>Digest</dt>
              <dd title={projection.seal.sealDigest}>{short(projection.seal.sealDigest)}</dd>
            </dl>
          )}
        </div>
        <div style={{ border: '1px solid #cbd5e1', padding: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>Promotion authority</h2>
          {projection.promotions.receipts.length === 0 ? (
            <p>No promotion receipt.</p>
          ) : (
            <ul>
              {projection.promotions.receipts.map((promotion) => (
                <li key={`${promotion.aliasId}-${promotion.receiptDigest}`}>
                  {promotion.aliasId} · {promotion.riskTier} · {promotion.status}
                </li>
              ))}
            </ul>
          )}
          <p style={{ color: '#64748b', fontSize: '0.85rem' }}>
            Recorded means this receipt is visible. A caller-scoped projection does not claim it is
            the current alias winner.
          </p>
          {projection.promotions.page.nextAfterReceiptDigest === null ? null : (
            <a
              href={pageHref({
                afterReceiptDigest: projection.promotions.page.nextAfterReceiptDigest,
              })}
            >
              Next promotion receipt page
            </a>
          )}
        </div>
      </section>
    </main>
  );
}
