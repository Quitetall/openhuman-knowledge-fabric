import type { CheckStatus, ReadinessReport } from './contracts.js';

/** One line per check, for a terminal or a log. */
export function formatReadiness(report: ReadinessReport): string {
  const mark: Record<CheckStatus, string> = {
    ok: 'ok      ',
    degraded: 'degraded',
    failed: 'FAILED  ',
    unknown: 'UNKNOWN ',
  };
  const formatPartition = (label: string, partition: ReadinessReport['service']) => [
    `${label}: ${partition.ready ? 'READY' : 'NOT READY'}`,
    ...partition.checks.map(
      (check) => `  ${mark[check.status]}  ${check.id}\n            ${check.detail}`,
    ),
  ];
  return [
    ...formatPartition('SERVICE', report.service),
    '',
    ...formatPartition('INSTITUTIONAL', report.institutional),
    '',
    'Exit status follows SERVICE readiness. Institutional failures block only governed operations.',
  ].join('\n');
}
