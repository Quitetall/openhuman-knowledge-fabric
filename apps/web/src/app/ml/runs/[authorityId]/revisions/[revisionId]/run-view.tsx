import { formatState } from '@kf/ui';
import { AuthoritySection } from './authority-section';
import { LineageSection } from './lineage-section';
import { MetricsSections } from './metrics-sections';
import type { RunProjection } from './run-projection';

export function RunView({
  projection,
  pageHref,
}: {
  readonly projection: RunProjection;
  readonly pageHref: (changes: Readonly<Record<string, string>>) => string;
}) {
  const nextMember = projection.lineage.members.page.nextAfterMember;
  const nextMetric = projection.metrics.page.nextAfterSequence;
  const nextSegment = projection.segments.page.nextAfterOrdinal;
  const nextPromotion = projection.promotions.page.nextAfterReceiptDigest;

  return (
    <main style={{ maxWidth: '72rem', margin: '2.5rem auto', padding: '0 1.5rem 5rem' }}>
      <p style={{ color: '#64748b', margin: 0 }}>ML RUN · {projection.schemaVersion}</p>
      <h1 style={{ marginTop: '0.25rem' }}>{projection.run.authorityId}</h1>
      <p>
        Revision {projection.run.revisionId} · {formatState(projection.run.classificationId)} ·
        policy {projection.run.policyId}
      </p>

      <LineageSection
        lineage={projection.lineage}
        nextPageHref={nextMember === null ? undefined : pageHref({ afterMember: nextMember })}
      />
      <MetricsSections
        metrics={projection.metrics}
        segments={projection.segments}
        nextMetricPageHref={
          nextMetric === null ? undefined : pageHref({ afterSequence: nextMetric })
        }
        nextSegmentPageHref={
          nextSegment === null ? undefined : pageHref({ afterOrdinal: String(nextSegment) })
        }
      />
      <AuthoritySection
        seal={projection.seal}
        promotions={projection.promotions}
        nextPromotionPageHref={
          nextPromotion === null ? undefined : pageHref({ afterReceiptDigest: nextPromotion })
        }
      />
    </main>
  );
}
