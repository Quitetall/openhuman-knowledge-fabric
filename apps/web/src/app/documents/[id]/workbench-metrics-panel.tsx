import { formatState } from '@kf/ui';
import type { MetricPanel as MetricPanelData } from '../../../lib/api';

export function MetricsPanel({ metrics }: { readonly metrics: MetricPanelData }) {
  return (
    <div>
      <h2>Linked metrics</h2>
      {metrics.status === 'available' ? (
        metrics.metrics.length === 0 ? (
          <p>No linked metrics.</p>
        ) : (
          <div className="kf-table-scroll" tabIndex={0} aria-label="Linked metrics table">
            <table
              aria-label="Linked metrics"
              style={{ width: '100%', borderCollapse: 'collapse' }}
            >
              <thead>
                <tr>
                  <th align="left">Metric</th>
                  <th align="left">Value</th>
                  <th align="left">Class</th>
                  <th align="left">Provenance</th>
                </tr>
              </thead>
              <tbody>
                {metrics.metrics.map((metric) => (
                  <tr key={metric.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                    <td>{metric.name}</td>
                    <td>
                      {metric.value}
                      {metric.unit === null ? '' : ` ${metric.unit}`}
                    </td>
                    <td>{formatState(metric.classification)}</td>
                    <td>{metric.provenance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <p
          style={{
            padding: '0.75rem',
            background: metrics.status === 'withheld' ? '#fef2f2' : '#f8fafc',
          }}
        >
          {metrics.status === 'withheld'
            ? 'Metrics withheld by access policy.'
            : metrics.status === 'unbound'
              ? 'No typed document-to-training-run binding exists. View metrics from an ML run.'
              : metrics.status === 'unavailable'
                ? 'Metric projection endpoint not commissioned.'
                : 'Metric projection failed closed.'}
        </p>
      )}
    </div>
  );
}
