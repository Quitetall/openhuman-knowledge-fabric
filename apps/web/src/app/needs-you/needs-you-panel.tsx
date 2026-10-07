import { randomUUID } from 'node:crypto';
import type { NeedsYou, NeedsYouProposal, NeedsYouRecord } from '../../lib/api/needs-you';
import { VerificationNote } from '../components/verification-note';
import { confirmProposed, declineProposed, verifyRecord, verifySelected } from './actions';

/**
 * Needs you: what waits on this person, and one gesture for each (ADR 0040 decisions 2, 5, 6, 10;
 * SAS §24B, KF-SAS-RQ-262, RQ-263, RQ-265, RQ-273).
 *
 * A self-contained panel so the dashboard (M3, KF-WAR-0005) can place it as one of its six; it
 * takes the API's answer and a `returnTo` path and owns nothing else. It renders only what the
 * API listed, which is what the person's grants reach; an empty section is absent, and an empty
 * panel says so in one line.
 *
 * Individual verify is offered only inside an opened record (`<details>`): the button is there
 * once the person has opened it, and it names the version they saw. Select-many is a separate,
 * plainly bulk gesture. State is shown by words and form, not colour alone (decision 11), and the
 * layout is one column that wraps at phone width (decision 10).
 */

const box = {
  border: '1px solid #cbd5e1',
  borderRadius: 6,
  padding: '0.75rem',
  margin: '0.5rem 0',
};
const field = { width: '100%', boxSizing: 'border-box' as const, margin: '0.25rem 0' };

function RecordItem({ item, returnTo }: { item: NeedsYouRecord; returnTo: string }) {
  return (
    <details style={box} data-record={item.id}>
      <summary style={{ cursor: 'pointer', overflowWrap: 'anywhere' }}>
        <strong>{item.title}</strong> · {item.objectType} · written by agent{' '}
        <code>{item.agentClientId}</code>
      </summary>
      <VerificationNote verification={item.verification} />
      <p style={{ margin: '0.25rem 0' }}>
        <a href={`/objects/${encodeURIComponent(item.id)}`}>Open the record</a> ·{' '}
        {item.classification} · {item.lifecycleState} · version {item.rowVersion} · {item.writtenAt}
      </p>
      <form action={verifyRecord}>
        <input type="hidden" name="recordId" value={item.id} />
        <input type="hidden" name="expectedVersion" value={String(item.rowVersion)} />
        <input type="hidden" name="gestureId" value={randomUUID()} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <label>
          Why it is right
          <input
            name="reason"
            required
            minLength={8}
            defaultValue="Read it and checked it against the source"
            style={field}
          />
        </label>
        <button type="submit">Verify this version</button>
      </form>
    </details>
  );
}

function ProposalItem({ item, returnTo }: { item: NeedsYouProposal; returnTo: string }) {
  return (
    <div style={box} data-proposal={item.id}>
      <p style={{ margin: 0, overflowWrap: 'anywhere' }}>
        Agent <code>{item.agentClientId}</code> proposes <strong>{item.actionType}</strong>
        {item.targetIds.length > 0 ? (
          <>
            {' '}
            on{' '}
            {item.targetIds.map((id) => (
              <a key={id} href={`/objects/${encodeURIComponent(id)}`}>
                {id.slice(0, 8)}
              </a>
            ))}
          </>
        ) : null}
        . It has not happened: only you can perform it.
      </p>
      {item.reason === null ? null : <p style={{ margin: '0.25rem 0' }}>“{item.reason}”</p>}
      {item.confirmableHere ? (
        <form action={confirmProposed} style={{ display: 'inline-block', marginRight: '0.5rem' }}>
          <input type="hidden" name="proposalId" value={item.id} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button type="submit">Perform it as my act</button>
        </form>
      ) : (
        <p style={{ margin: '0.25rem 0' }}>
          Proposed under another of your assignments; switch to it to perform it.
        </p>
      )}
      <form action={declineProposed} style={{ marginTop: '0.5rem' }}>
        <input type="hidden" name="proposalId" value={item.id} />
        <input type="hidden" name="gestureId" value={randomUUID()} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <label>
          Why not
          <input name="reason" required minLength={8} style={field} />
        </label>
        <button type="submit">Decline</button>
      </form>
    </div>
  );
}

export function NeedsYouPanel({
  data,
  returnTo = '/needs-you',
}: {
  readonly data: NeedsYou;
  readonly returnTo?: string;
}) {
  const { toVerify, awaitingOthers, proposals } = data;
  if (toVerify.total + awaitingOthers.total + proposals.total === 0) {
    return (
      <section aria-label="Needs you">
        <p>Nothing needs you.</p>
      </section>
    );
  }
  return (
    <section aria-label="Needs you" style={{ maxWidth: '52rem' }}>
      {proposals.total === 0 ? null : (
        <>
          <h2>Proposed for you to perform ({proposals.total})</h2>
          {proposals.items.map((item) => (
            <ProposalItem key={item.id} item={item} returnTo={returnTo} />
          ))}
        </>
      )}
      {toVerify.total === 0 ? null : (
        <>
          <h2>Agent submissions to verify ({toVerify.total})</h2>
          <p style={{ color: '#475569' }}>
            Unverified until someone with authority checks them. Open one to verify it as read; or
            select several and verify them together, which is recorded as a bulk promotion.
          </p>
          {toVerify.items.map((item) => (
            <RecordItem key={item.id} item={item} returnTo={returnTo} />
          ))}
          <form action={verifySelected} style={box}>
            <fieldset style={{ border: 0, padding: 0 }}>
              <legend>Verify several at once (recorded as promoted in bulk)</legend>
              {toVerify.items.map((item) => (
                <label key={item.id} style={{ display: 'block', overflowWrap: 'anywhere' }}>
                  <input type="checkbox" name="recordIds" value={item.id} /> {item.title}
                </label>
              ))}
            </fieldset>
            <input type="hidden" name="gestureId" value={randomUUID()} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <label>
              Why they are right
              <input name="reason" required minLength={8} style={field} />
            </label>
            <button type="submit">Verify selected</button>
          </form>
        </>
      )}
      {awaitingOthers.total === 0 ? null : (
        <>
          <h2>Your agents’ submissions, awaiting someone else ({awaitingOthers.total})</h2>
          <p style={{ color: '#475569' }}>
            You cannot verify what was written for you; another person with authority does.
          </p>
          <ul>
            {awaitingOthers.items.map((item) => (
              <li key={item.id} style={{ overflowWrap: 'anywhere' }}>
                <a href={`/objects/${encodeURIComponent(item.id)}`}>{item.title}</a> ·{' '}
                {item.verification.label} · agent <code>{item.agentClientId}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
