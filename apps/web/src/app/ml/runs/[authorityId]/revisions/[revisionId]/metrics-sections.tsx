import { formatInstant, formatState } from '@kf/ui';
import { DigestDisclosure } from '../../../../../components/digest-disclosure';
import type { MetricEvent, RunProjection } from './run-projection';

function metricValue(event: MetricEvent): string {
  if (event.value.kind === 'number') {
    return `${event.value.number}${event.unitId === null ? '' : ` ${event.unitId}`}`;
  }
  if (event.value.kind === 'safe_enum') return event.value.enumId;
  return formatInstant(event.value.timestamp);
}

export function MetricsSections({
  metrics,
  segments,
  nextMetricPageHref,
  nextSegmentPageHref,
}: {
  readonly metrics: RunProjection['metrics'];
  readonly segments: RunProjection['segments'];
  readonly nextMetricPageHref: string | undefined;
  readonly nextSegmentPageHref: string | undefined;
}) {
  return (
    <>
      <section style={{ marginTop: '2rem' }}>
        <h2>Metric events</h2>
        {metrics.events.length === 0 ? (
          <p>No events in this page.</p>
        ) : (
          <div className="kf-table-scroll" tabIndex={0} aria-label="Metric events table">
            <table aria-label="Metric events" style={{ width: '100%', borderCollapse: 'collapse' }}>
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
                {metrics.events.map((event) => (
                  <tr key={event.sequence} style={{ borderTop: '1px solid #e2e8f0' }}>
                    <td>{event.sequence}</td>
                    <td>{event.metricId}</td>
                    <td>{metricValue(event)}</td>
                    <td>{formatState(event.status)}</td>
                    <td>
                      <DigestDisclosure digest={event.eventDigest} label="event digest" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextMetricPageHref === undefined ? null : (
          <a href={nextMetricPageHref}>Next metric page</a>
        )}
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2>Metric segments</h2>
        {segments.items.length === 0 ? (
          <p>No segments in this page.</p>
        ) : (
          <div className="kf-table-scroll" tabIndex={0} aria-label="Metric segments table">
            <table
              aria-label="Metric segments"
              style={{ width: '100%', borderCollapse: 'collapse' }}
            >
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
                {segments.items.map((segment) => (
                  <tr key={segment.ordinal} style={{ borderTop: '1px solid #e2e8f0' }}>
                    <td>{segment.ordinal}</td>
                    <td>{segment.reference.authorityId}</td>
                    <td>
                      {segment.firstSequence}–{segment.lastSequence}
                    </td>
                    <td>{segment.eventCount}</td>
                    <td>
                      <DigestDisclosure digest={segment.metadataDigest} label="segment digest" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextSegmentPageHref === undefined ? null : (
          <a href={nextSegmentPageHref}>Next segment page</a>
        )}
      </section>
    </>
  );
}
