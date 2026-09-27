import { formatState } from '@kf/ui';
import { VerificationNote } from '../../components/verification-note';
import { recordHref } from '../search-view';
import type { ReplayState } from './state';

/** What a replay found: the records the original ceiling withheld that the reader may see now. */
export function ReplayResult({ state }: { readonly state: ReplayState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'refused') {
    return (
      <p role="alert" className="kf-status kf-status-warning">
        {state.message}
      </p>
    );
  }
  const { replay } = state;
  return (
    <div role="status" data-replayed={replay.recordedQueryId} style={{ marginTop: '0.6rem' }}>
      {replay.withheld.length === 0 ? (
        <p className="kf-status kf-status-neutral">
          Nothing matching this query was withheld at {formatState(replay.askerCeiling)} that you
          can read now.
        </p>
      ) : (
        <>
          <p className="kf-status kf-status-neutral">
            {replay.withheld.length} record{replay.withheld.length === 1 ? '' : 's'} matching this
            query {replay.withheld.length === 1 ? 'was' : 'were'} withheld when you asked at{' '}
            {formatState(replay.askerCeiling)}. {replay.counted} counted toward access demand for
            the first time; the demand count records how many distinct people wanted a record, never
            who.
          </p>
          <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
            {replay.withheld.map((hit) => {
              const href = recordHref(hit.objectType, hit.objectId);
              return (
                <li key={hit.objectId}>
                  {href === undefined ? hit.title : <a href={href}>{hit.title}</a>} ·{' '}
                  {formatState(hit.objectType)} · {formatState(hit.classification)}
                  <VerificationNote verification={hit.verification} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
