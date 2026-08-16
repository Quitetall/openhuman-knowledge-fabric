import { formatInstant, formatState } from '@kf/ui';
import { DigestDisclosure } from '../../../../../components/digest-disclosure';
import type { AggregateReference, RunProjection } from './run-projection';

function ReferenceProof({ reference }: { readonly reference: AggregateReference }) {
  return (
    <span style={{ display: 'grid', gap: '0.2rem', overflowWrap: 'anywhere' }}>
      <span>
        <code>{reference.kind}</code> · {reference.authorityId}@{reference.revisionId}
      </span>
      <span>
        classification {reference.classificationId} · policy {reference.policyId}
      </span>
      <span>
        SHA-256 <code>{reference.sha256}</code>
      </span>
    </span>
  );
}

export function AuthoritySection({
  seal,
  promotions,
  nextPromotionPageHref,
}: {
  readonly seal: RunProjection['seal'];
  readonly promotions: RunProjection['promotions'];
  readonly nextPromotionPageHref: string | undefined;
}) {
  return (
    <section style={{ marginTop: '2rem' }} className="kf-responsive-grid">
      <div style={{ border: '1px solid #cbd5e1', padding: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Run seal</h2>
        {seal === null ? (
          <p>Unsealed. Metrics remain provisional.</p>
        ) : (
          <dl>
            <dt>Events</dt>
            <dd>{seal.eventCount}</dd>
            <dt>Key</dt>
            <dd>{seal.signingKeyId}</dd>
            <dt>Digest</dt>
            <dd>
              <DigestDisclosure digest={seal.sealDigest} label="seal digest" />
            </dd>
          </dl>
        )}
      </div>
      <div style={{ border: '1px solid #cbd5e1', padding: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Promotion authority</h2>
        {promotions.receipts.length === 0 ? (
          <p>
            No promotion receipt is visible on this caller-scoped page. This page cannot prove that
            no receipt exists.
          </p>
        ) : (
          <ul style={{ paddingLeft: '1.25rem' }}>
            {promotions.receipts.map((promotion) => (
              <li
                key={`${promotion.aliasId}-${promotion.receiptDigest}`}
                style={{ marginBottom: '0.75rem' }}
              >
                <strong>{promotion.aliasId}</strong> · {formatState(promotion.riskTier)} ·{' '}
                {formatState(promotion.status)}
                <details style={{ marginTop: '0.35rem' }}>
                  <summary>Receipt evidence</summary>
                  <dl style={{ fontSize: '0.85rem' }}>
                    <dt>Candidate</dt>
                    <dd>
                      <ReferenceProof reference={promotion.candidate} />
                    </dd>
                    <dt>Policy</dt>
                    <dd>
                      <ReferenceProof reference={promotion.policy} />
                    </dd>
                    <dt>Technical Authority decision</dt>
                    <dd>
                      <ReferenceProof reference={promotion.technicalAuthorityDecision} />
                    </dd>
                    <dt>Quality Authority decision</dt>
                    <dd>
                      <ReferenceProof reference={promotion.qualityAuthorityDecision} />
                    </dd>
                    <dt>Promoted at</dt>
                    <dd>{formatInstant(promotion.promotedAt)}</dd>
                    <dt>Signing key</dt>
                    <dd style={{ overflowWrap: 'anywhere' }}>{promotion.signingKeyId}</dd>
                    <dt>Receipt SHA-256</dt>
                    <dd>
                      <code style={{ overflowWrap: 'anywhere' }}>{promotion.receiptDigest}</code>
                    </dd>
                    <dt>Ed25519 signature</dt>
                    <dd>
                      <code style={{ overflowWrap: 'anywhere' }}>{promotion.signature}</code>
                    </dd>
                    {promotion.revocation === null ? null : (
                      <>
                        <dt>Revocation</dt>
                        <dd>
                          {promotion.revocation.reasonCode} ·{' '}
                          {formatInstant(promotion.revocation.revokedAt)}
                        </dd>
                      </>
                    )}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )}
        <p style={{ color: '#64748b', fontSize: '0.85rem' }}>
          Recorded means this receipt is visible. A caller-scoped projection does not claim it is
          the current alias winner.
        </p>
        {nextPromotionPageHref === undefined ? null : (
          <a href={nextPromotionPageHref}>Next promotion receipt page</a>
        )}
      </div>
    </section>
  );
}
