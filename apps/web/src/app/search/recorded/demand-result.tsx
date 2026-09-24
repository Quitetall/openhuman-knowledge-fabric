import { formatState } from '@kf/ui';
import { VerificationNote } from '../../components/verification-note';
import { recordHref } from '../search-view';
import type { DemandState } from './state';

/**
 * What a demand replay found: records people cleared lower searched for and could not see, each
 * with how many distinct people wanted it — never who, and never what they typed (ADR 0029).
 */
export function DemandResult({ state }: { readonly state: DemandState }) {
  if (state.status === 'idle') return null;
  const { replay } = state;
  return (
    <div role="status" data-demand-replayed={replay.replayed} style={{ marginTop: '0.6rem' }}>
      <p className="kf-status kf-status-neutral">
        Replayed {replay.replayed} recorded quer{replay.replayed === 1 ? 'y' : 'ies'} asked below
        your clearance{replay.truncated ? ' (the newest; more remain)' : ''}. {replay.counted}{' '}
        counted toward access demand for the first time. A quiet result is not evidence that nobody
        needs access: people who stopped searching are not counted.
      </p>
      {replay.records.length > 0 && (
        <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
          {replay.records.map((demanded) => {
            const href = recordHref(demanded.objectType, demanded.objectId);
            return (
              <li key={demanded.objectId}>
                {href === undefined ? demanded.title : <a href={href}>{demanded.title}</a>} ·{' '}
                {formatState(demanded.objectType)} · {formatState(demanded.classification)} · wanted
                by {demanded.distinctPersonCount}{' '}
                {demanded.distinctPersonCount === 1 ? 'person' : 'people'}
                <VerificationNote verification={demanded.verification} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
