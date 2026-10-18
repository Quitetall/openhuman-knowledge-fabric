import type { ReactNode } from 'react';
import { classificationWords, type IdentityLine } from '../../lib/auth/identity-label';

/**
 * Who is signed in, in words: name, role, organization and what they can see at most. The ids the
 * session carries are kept for whoever needs them — support, an operator — inside a folded
 * "Details", never in the line a person reads.
 */
export function IdentityBar({
  line,
  ids,
  ceiling,
  actions,
}: {
  readonly line: IdentityLine;
  readonly ids: readonly { readonly label: string; readonly value: string }[];
  /** The classification id of the session's ceiling, explained in Details. */
  readonly ceiling: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="kf-identity" aria-label="Current authority context">
      <p className="kf-identity-line" data-identity-line="">
        <strong className="kf-identity-person">{line.person}</strong>
        <span className="kf-identity-sep" aria-hidden="true">
          {' · '}
        </span>
        <span>{line.role}</span>
        <span className="kf-identity-sep" aria-hidden="true">
          {' · '}
        </span>
        <span>{line.organization}</span>
        <span className="kf-identity-sep" aria-hidden="true">
          {' · '}
        </span>
        <span title={`You can see records up to: ${classificationWords(ceiling)}`}>
          Sees up to {line.ceiling}
        </span>
      </p>
      <details className="kf-identity-details">
        <summary>Details</summary>
        <div className="kf-identity-panel">
          <p className="kf-identity-note">
            You can see records marked up to: <strong>{classificationWords(ceiling)}</strong>.
          </p>
          <dl className="kf-identity-ids">
            {ids.map((entry) => (
              <div key={entry.label}>
                <dt>{entry.label}</dt>
                <dd>
                  <code>{entry.value}</code>
                </dd>
              </div>
            ))}
          </dl>
          {actions}
        </div>
      </details>
    </div>
  );
}
