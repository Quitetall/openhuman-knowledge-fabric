import { formatState } from '@kf/ui';
import { DigestDisclosure } from '../../../../../components/digest-disclosure';
import type { AggregateReference, RunProjection } from './run-projection';

export function LineageSection({
  lineage,
  nextPageHref,
}: {
  readonly lineage: RunProjection['lineage'];
  readonly nextPageHref: string | undefined;
}) {
  const references: readonly (readonly [string, AggregateReference])[] = [
    ['code', lineage.code],
    ['recipe', lineage.recipe],
    ['environment', lineage.environment],
    ['metric policy', lineage.metricPolicy],
    ...lineage.members.items.map((member) => [formatState(member.role), member.reference] as const),
  ];

  return (
    <section>
      <h2>Lineage</h2>
      <div>
        <DigestDisclosure digest={lineage.lineageDigest} label="lineage digest" />
      </div>
      <div className="kf-table-scroll" tabIndex={0} aria-label="Run lineage table">
        <table aria-label="Run lineage" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Role</th>
              <th align="left">Authority</th>
              <th align="left">Revision</th>
              <th align="left">Digest</th>
            </tr>
          </thead>
          <tbody>
            {references.map(([role, ref], index) => (
              <tr
                key={`${role}-${ref.authorityId}-${index}`}
                style={{ borderTop: '1px solid #e2e8f0' }}
              >
                <td>{role}</td>
                <td>{ref.authorityId}</td>
                <td>{ref.revisionId}</td>
                <td>
                  <DigestDisclosure digest={ref.sha256} label={`${role} SHA-256`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextPageHref === undefined ? null : <a href={nextPageHref}>Next lineage member page</a>}
    </section>
  );
}
