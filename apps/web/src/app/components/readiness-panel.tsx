import type { OperationalCheckStatus, OperationalReadinessPartition } from '../../lib/api';

const READINESS_COLOUR: Record<OperationalCheckStatus, string> = {
  ok: '#047857',
  degraded: '#b45309',
  failed: '#b91c1c',
  unknown: '#6b7280',
};

function measuredFacts(
  measured: Readonly<Record<string, number | string | null>> | undefined,
): string | undefined {
  if (measured === undefined) return undefined;
  const entries = Object.entries(measured);
  return entries.length === 0
    ? undefined
    : entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
        .join(' · ');
}

/**
 * One readiness partition.
 *
 * `redacted` keeps each check's name and verdict and drops what it measured. The detail and
 * measured facts name organizations by id, count their records, state backup posture and
 * quote the error of a check that could not run; this page renders before sign-in, and the
 * API gives that report only to its own host, so the page must not hand it on to anyone.
 */
export function ReadinessPanel({
  title,
  partition,
  readyLabel,
  blockedLabel,
  redacted = false,
}: {
  readonly title: string;
  readonly partition: OperationalReadinessPartition;
  readonly readyLabel: string;
  readonly blockedLabel: string;
  readonly redacted?: boolean;
}) {
  return (
    <section aria-labelledby={`${title.toLowerCase().replaceAll(' ', '-')}-heading`}>
      <h2
        id={`${title.toLowerCase().replaceAll(' ', '-')}-heading`}
        style={{ fontSize: '1rem', marginTop: '2rem' }}
      >
        {title}
      </h2>
      <p className={`kf-status ${partition.ready ? 'kf-status-success' : 'kf-status-error'}`}>
        <strong>{partition.ready ? readyLabel : blockedLabel}</strong> {partition.checks.length}{' '}
        check(s) measured.
      </p>
      <ul style={{ paddingLeft: '1.25rem' }}>
        {partition.checks.map((check) => {
          const measured = redacted ? undefined : measuredFacts(check.measured);
          return (
            <li key={check.id} style={{ marginBottom: '0.65rem' }}>
              <code>{check.id}</code>{' '}
              <strong style={{ color: READINESS_COLOUR[check.status] }}>— {check.status}</strong>
              <div style={{ color: '#475569', fontSize: '0.85rem' }}>
                {redacted ? 'Sign in to see what was measured.' : check.detail}
              </div>
              {measured === undefined ? null : (
                <div style={{ color: '#64748b', fontSize: '0.78rem' }}>{measured}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
